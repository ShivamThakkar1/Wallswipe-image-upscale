const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_USERNAME = '@WallSwipe';
const PORT = process.env.PORT || 3000;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;

// NocoDB configuration
const NOCODB_CONFIG = {
    API_TOKEN: process.env.NOCODB_API_TOKEN,
    BASE_ID: process.env.NOCODB_BASE_ID,
    BASE_URL: process.env.NOCODB_BASE_URL,
    TABLE_ID: process.env.NOCODB_TABLE_ID,
    WORKSPACE_ID: process.env.NOCODB_WORKSPACE_ID
};

// Create bot instance
const bot = new TelegramBot(BOT_TOKEN, { 
    polling: process.env.NODE_ENV !== 'production',
    webHook: process.env.NODE_ENV === 'production' 
});

// For Render deployment - set webhook
if (process.env.NODE_ENV === 'production') {
    const url = process.env.RENDER_EXTERNAL_URL || `https://${process.env.RENDER_SERVICE_SLUG}.onrender.com`;
    bot.setWebHook(`${url}/bot${BOT_TOKEN}`);
    
    // Express server for webhook
    const express = require('express');
    const app = express();
    app.use(express.json());
    
    app.post(`/bot${BOT_TOKEN}`, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
    
    app.get('/', (req, res) => {
        res.send('WallSwipe Image Upscaler Bot is running!');
    });
    
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

// Level mapping
const levelMap = {
    'basic': '1',
    'premium': '2', 
    'elite': '3',
    'pro': '4'
};

// Track if user has seen privacy policy
if (!global.privacyShown) global.privacyShown = new Set();

// In-memory stats (for immediate tracking)
if (!global.dailyStats) {
    global.dailyStats = {
        totalUsers: new Set(),
        newUsers: new Set(),
        imagesProcessed: 0,
        qualityUsage: { basic: 0, premium: 0, elite: 0, pro: 0 },
        date: new Date().toDateString()
    };
}

// NocoDB API helper functions
async function makeNocoRequest(method, endpoint, data = null) {
    const url = `${NOCODB_CONFIG.BASE_URL}/api/v2/tables/${NOCODB_CONFIG.TABLE_ID}/records${endpoint}`;
    
    const config = {
        method,
        url,
        headers: {
            'xc-token': NOCODB_CONFIG.API_TOKEN,
            'Content-Type': 'application/json'
        }
    };
    
    if (data) {
        config.data = data;
    }
    
    try {
        const response = await axios(config);
        return response.data;
    } catch (error) {
        console.error('NocoDB request error:', error.response?.data || error.message);
        throw error;
    }
}

// Save or update user in NocoDB
async function saveUserToNoco(userId, username, firstName, lastName, isNew = false) {
    try {
        // Check if user exists
        const existingUser = await makeNocoRequest('GET', `?where=(user_id,eq,${userId})`);
        
        const userData = {
            user_id: userId,
            username: username || null,
            first_name: firstName || null,
            last_name: lastName || null,
            last_active: new Date().toISOString(),
            total_images_processed: isNew ? 0 : undefined
        };
        
        if (existingUser.list && existingUser.list.length > 0) {
            // Update existing user
            const recordId = existingUser.list[0].Id;
            await makeNocoRequest('PATCH', `/${recordId}`, userData);
        } else {
            // Create new user
            userData.join_date = new Date().toISOString();
            userData.total_images_processed = 0;
            await makeNocoRequest('POST', '', userData);
        }
    } catch (error) {
        console.error('Error saving user to NocoDB:', error);
    }
}

// Update user image count in NocoDB
async function updateUserImageCount(userId, quality) {
    try {
        const existingUser = await makeNocoRequest('GET', `?where=(user_id,eq,${userId})`);
        
        if (existingUser.list && existingUser.list.length > 0) {
            const record = existingUser.list[0];
            const recordId = record.Id;
            const currentCount = record.total_images_processed || 0;
            
            const updateData = {
                total_images_processed: currentCount + 1,
                last_active: new Date().toISOString(),
                last_quality_used: quality
            };
            
            await makeNocoRequest('PATCH', `/${recordId}`, updateData);
        }
    } catch (error) {
        console.error('Error updating user image count:', error);
    }
}

// Get stats from NocoDB
async function getStatsFromNoco(days = 1) {
    try {
        const dateFrom = new Date();
        dateFrom.setDate(dateFrom.getDate() - days);
        const dateFromISO = dateFrom.toISOString();
        
        // Get users who joined in the specified period
        const newUsers = await makeNocoRequest('GET', `?where=(join_date,gte,${dateFromISO})`);
        
        // Get users who were active in the specified period
        const activeUsers = await makeNocoRequest('GET', `?where=(last_active,gte,${dateFromISO})`);
        
        // Get total users
        const totalUsers = await makeNocoRequest('GET', '?limit=1&offset=0');
        
        return {
            newUsersCount: newUsers.list?.length || 0,
            activeUsersCount: activeUsers.list?.length || 0,
            totalUsersCount: totalUsers.pageInfo?.totalRows || 0,
            newUsers: newUsers.list || [],
            activeUsers: activeUsers.list || []
        };
    } catch (error) {
        console.error('Error getting stats from NocoDB:', error);
        return { newUsersCount: 0, activeUsersCount: 0, totalUsersCount: 0, newUsers: [], activeUsers: [] };
    }
}

// Reset daily stats
function resetDailyStats() {
    const today = new Date().toDateString();
    if (global.dailyStats.date !== today) {
        global.dailyStats = {
            totalUsers: new Set(),
            newUsers: new Set(),
            imagesProcessed: 0,
            qualityUsage: { basic: 0, premium: 0, elite: 0, pro: 0 },
            date: today
        };
    }
}

// Send daily stats to admin
async function sendDailyStatsToAdmin() {
    if (!ADMIN_USER_ID) {
        console.log('No admin user ID configured');
        return;
    }
    
    try {
        resetDailyStats();
        
        // Get stats from NocoDB
        const dbStats = await getStatsFromNoco(1); // Last 24 hours
        const weeklyStats = await getStatsFromNoco(7); // Last 7 days
        const monthlyStats = await getStatsFromNoco(30); // Last 30 days
        
        // Combine with in-memory stats
        const statsMessage = `📊 **Daily Bot Statistics**
📅 Date: ${new Date().toLocaleDateString()}

**📈 User Statistics:**
👥 Total Users: ${dbStats.totalUsersCount}
🆕 New Users (24h): ${dbStats.newUsersCount}
🔥 Active Users (24h): ${dbStats.activeUsersCount}
📊 Active Users (7d): ${weeklyStats.activeUsersCount}
📈 Active Users (30d): ${monthlyStats.activeUsersCount}

**🖼️ Image Processing:**
📸 Images Processed Today: ${global.dailyStats.imagesProcessed}
🔧 Basic Quality: ${global.dailyStats.qualityUsage.basic}
⭐ Premium Quality: ${global.dailyStats.qualityUsage.premium}
💎 Elite Quality: ${global.dailyStats.qualityUsage.elite}
🚀 Pro Quality: ${global.dailyStats.qualityUsage.pro}

**📱 Channel Growth:**
📢 Channel: ${CHANNEL_USERNAME}

**⏰ Report Generated:** ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        
        await bot.sendMessage(ADMIN_USER_ID, statsMessage, { parse_mode: 'Markdown' });
        
        // Send detailed user list if there are new users
        if (dbStats.newUsers.length > 0) {
            let usersList = `📋 **New Users Details:**\n\n`;
            dbStats.newUsers.forEach((user, index) => {
                usersList += `${index + 1}. ${user.first_name || 'N/A'} ${user.last_name || ''}\n`;
                usersList += `   👤 @${user.username || 'No username'}\n`;
                usersList += `   🆔 ID: ${user.user_id}\n`;
                usersList += `   📅 Joined: ${new Date(user.join_date).toLocaleString()}\n\n`;
            });
            
            if (usersList.length < 4000) { // Telegram message limit
                await bot.sendMessage(ADMIN_USER_ID, usersList, { parse_mode: 'Markdown' });
            } else {
                // Split message if too long
                const chunks = usersList.match(/.{1,3900}/gs);
                for (const chunk of chunks) {
                    await bot.sendMessage(ADMIN_USER_ID, chunk, { parse_mode: 'Markdown' });
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Avoid rate limits
                }
            }
        }
        
        console.log('Daily stats sent to admin successfully');
    } catch (error) {
        console.error('Error sending daily stats to admin:', error);
        // Send error notification to admin
        try {
            await bot.sendMessage(ADMIN_USER_ID, `❌ Error generating daily stats: ${error.message}`);
        } catch (e) {
            console.error('Failed to send error notification:', e);
        }
    }
}

// Schedule daily stats (every day at 9:00 AM)
cron.schedule('0 9 * * *', sendDailyStatsToAdmin, {
    timezone: "UTC"
});

// Admin command to get instant stats
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Check if user is admin
    if (userId.toString() !== ADMIN_USER_ID) {
        bot.sendMessage(chatId, '❌ Access denied. This command is for admins only.');
        return;
    }
    
    try {
        const statusMsg = await bot.sendMessage(chatId, '📊 Generating stats...');
        
        resetDailyStats();
        const dbStats = await getStatsFromNoco(1);
        const weeklyStats = await getStatsFromNoco(7);
        const monthlyStats = await getStatsFromNoco(30);
        
        const statsMessage = `📊 **Bot Statistics**
📅 Generated: ${new Date().toLocaleString()}

**👥 User Statistics:**
📈 Total Users: ${dbStats.totalUsersCount}
🆕 New (24h): ${dbStats.newUsersCount}
🔥 Active (24h): ${dbStats.activeUsersCount}
📊 Active (7d): ${weeklyStats.activeUsersCount}
📈 Active (30d): ${monthlyStats.activeUsersCount}

**🖼️ Today's Activity:**
📸 Images Processed: ${global.dailyStats.imagesProcessed}
🔧 Basic: ${global.dailyStats.qualityUsage.basic}
⭐ Premium: ${global.dailyStats.qualityUsage.premium}
💎 Elite: ${global.dailyStats.qualityUsage.elite}
🚀 Pro: ${global.dailyStats.qualityUsage.pro}

Use /fullstats for detailed user information.`;
        
        await bot.editMessageText(statsMessage, {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown'
        });
        
    } catch (error) {
        console.error('Error generating stats:', error);
        bot.sendMessage(chatId, `❌ Error generating stats: ${error.message}`);
    }
});

// Admin command to get full stats with user details
bot.onText(/\/fullstats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (userId.toString() !== ADMIN_USER_ID) {
        bot.sendMessage(chatId, '❌ Access denied. This command is for admins only.');
        return;
    }
    
    await sendDailyStatsToAdmin();
    bot.sendMessage(chatId, '✅ Full stats sent!');
});

// Check if user is in channel
async function checkChannelMembership(userId) {
    try {
        const member = await bot.getChatMember(CHANNEL_USERNAME, userId);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (error) {
        console.error('Error checking channel membership:', error);
        return false;
    }
}

// Send channel join message
function sendChannelJoinMessage(chatId) {
    const keyboard = {
        inline_keyboard: [[
            { text: '📢 Join Channel', url: `https://t.me/${CHANNEL_USERNAME.replace('@', '')}` },
            { text: '✅ Check Again', callback_data: 'check_membership' }
        ]]
    };
    
    bot.sendMessage(chatId, 
        `🔒 To use this bot for FREE, you must join our channel first!\n\n` +
        `📢 Channel: ${CHANNEL_USERNAME}\n\n` +
        `After joining, click "Check Again" to continue.`, 
        { reply_markup: keyboard }
    );
}

// Track user interaction
async function trackUser(user, isNewUser = false) {
    resetDailyStats();
    
    const userId = user.id;
    global.dailyStats.totalUsers.add(userId);
    
    if (isNewUser) {
        global.dailyStats.newUsers.add(userId);
    }
    
    // Save to NocoDB
    await saveUserToNoco(
        userId,
        user.username,
        user.first_name,
        user.last_name,
        isNewUser
    );
}

// Start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const user = msg.from;
    
    // Check if this is a new user
    const isNewUser = !global.privacyShown.has(userId);
    
    // Track user
    await trackUser(user, isNewUser);
    
    // Show privacy policy only for first-time users
    if (isNewUser) {
        const privacyMessage = `📄 **Privacy Policy:**
When you use this bot, your images are sent to third-party AI services (e.g., image upscaling APIs) to process and return enhanced results.
These third-party services **may temporarily store or analyze** the image data as part of their operation. We do not control how third-party APIs handle data, and by using this bot, you consent to their data handling practices.
We do **not collect or store** your personal information (e.g., names, usernames, chats). Images are not saved on our servers and are processed only to deliver the result.
By using this bot, you agree to this data processing and you accept the Telegram Bot Standard Privacy Policy:
🔗 https://telegram.org/privacy-tpa
📌 Powered by @WallSwipe

━━━━━━━━━━━━━━━━━━━━━━━━━`;
        
        await bot.sendMessage(chatId, privacyMessage, { parse_mode: 'Markdown' });
        global.privacyShown.add(userId);
    }
    
    const isMember = await checkChannelMembership(userId);
    
    if (!isMember) {
        sendChannelJoinMessage(chatId);
        return;
    }
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '🔧 Basic', callback_data: 'scale_basic' }],
            [{ text: '⭐ Premium', callback_data: 'scale_premium' }],
            [{ text: '💎 Elite', callback_data: 'scale_elite' }],
            [{ text: '🚀 Pro', callback_data: 'scale_pro' }]
        ]
    };
    
    bot.sendMessage(chatId, 
        `🖼️ Welcome to WallSwipe Image Upscaler!\n\n` +
        `Choose your upscale quality and send me an image:`, 
        { reply_markup: keyboard }
    );
});

// Quality selection command (separate from start)
bot.onText(/\/quality/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const user = msg.from;
    
    // Track user
    await trackUser(user);
    
    const isMember = await checkChannelMembership(userId);
    
    if (!isMember) {
        sendChannelJoinMessage(chatId);
        return;
    }
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '🔧 Basic', callback_data: 'scale_basic' }],
            [{ text: '⭐ Premium', callback_data: 'scale_premium' }],
            [{ text: '💎 Elite', callback_data: 'scale_elite' }],
            [{ text: '🚀 Pro', callback_data: 'scale_pro' }]
        ]
    };
    
    bot.sendMessage(chatId, 
        `🖼️ Choose your upscale quality:`, 
        { reply_markup: keyboard }
    );
});

// Privacy command
bot.onText(/\/privacy/, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    
    // Track user
    await trackUser(user);
    
    const privacyMessage = `📄 **Privacy Policy:**
When you use this bot, your images are sent to third-party AI services (e.g., image upscaling APIs) to process and return enhanced results.
These third-party services **may temporarily store or analyze** the image data as part of their operation. We do not control how third-party APIs handle data, and by using this bot, you consent to their data handling practices.
We do **not collect or store** your personal information (e.g., names, usernames, chats). Images are not saved on our servers and are processed only to deliver the result.
By using this bot, you agree to this data processing and you accept the Telegram Bot Standard Privacy Policy:
🔗 https://telegram.org/privacy-tpa
📌 Powered by @WallSwipe`;
    
    bot.sendMessage(chatId, privacyMessage, { parse_mode: 'Markdown' });
});

// Help command
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    
    // Track user
    await trackUser(user);
    
    const helpMessage = `🤖 **WallSwipe Image Upscaler Bot Help**

**How to use:**
1️⃣ Use /start to begin
2️⃣ Join our channel @WallSwipe (required for free use)
3️⃣ Select upscale quality (Basic, Premium, Elite, Pro)
4️⃣ Send any image to upscale
5️⃣ Receive your enhanced image!

**Available Commands:**
• /start - Start the bot and show quality options
• /quality - Change upscale quality anytime
• /help - Show this help message
• /privacy - View privacy policy

**Upscale Qualities:**
🔧 **Basic** - Standard quality enhancement
⭐ **Premium** - Better quality with more details
💎 **Elite** - High-quality enhancement
🚀 **Pro** - Maximum quality upscaling

**Supported Formats:**
✅ JPG, JPEG, PNG images
✅ Send as photo or document
✅ Any image size

**Requirements:**
📢 Must join @WallSwipe channel to use for free

📌 Powered by @WallSwipe`;
    
    bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Handle callback queries
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const user = callbackQuery.from;
    const data = callbackQuery.data;
    
    // Track user
    await trackUser(user);
    
    if (data === 'check_membership') {
        const isMember = await checkChannelMembership(userId);
        
        if (isMember) {
            bot.editMessageText(
                `✅ Great! You're now a member. Choose your upscale quality:`,
                {
                    chat_id: chatId,
                    message_id: callbackQuery.message.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔧 Basic', callback_data: 'scale_basic' }],
                            [{ text: '⭐ Premium', callback_data: 'scale_premium' }],
                            [{ text: '💎 Elite', callback_data: 'scale_elite' }],
                            [{ text: '🚀 Pro', callback_data: 'scale_pro' }]
                        ]
                    }
                }
            );
        } else {
            bot.answerCallbackQuery(callbackQuery.id, {
                text: '❌ You still need to join the channel first!',
                show_alert: true
            });
        }
        return;
    }
    
    if (data.startsWith('scale_')) {
        const level = data.replace('scale_', '');
        
        // Store user's choice in memory (for production, use Redis or database)
        if (!global.userChoices) global.userChoices = {};
        global.userChoices[userId] = level;
        
        bot.editMessageText(
            `✅ Selected: ${level.toUpperCase()}\n\n📸 Now send me an image to upscale!`,
            {
                chat_id: chatId,
                message_id: callbackQuery.message.message_id
            }
        );
    }
    
    bot.answerCallbackQuery(callbackQuery.id);
});

// Handle photo uploads
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const user = msg.from;
    
    // Track user
    await trackUser(user);
    
    // Check channel membership
    const isMember = await checkChannelMembership(userId);
    
    if (!isMember) {
        sendChannelJoinMessage(chatId);
        return;
    }
    
    // Check if user has selected a scale level
    if (!global.userChoices || !global.userChoices[userId]) {
        const keyboard = {
            inline_keyboard: [
                [{ text: '🔧 Basic', callback_data: 'scale_basic' }],
                [{ text: '⭐ Premium', callback_data: 'scale_premium' }],
                [{ text: '💎 Elite', callback_data: 'scale_elite' }],
                [{ text: '🚀 Pro', callback_data: 'scale_pro' }]
            ]
        };
        
        bot.sendMessage(chatId, 
            `⚠️ Please select upscale quality first:`, 
            { reply_markup: keyboard }
        );
        return;
    }
    
    const selectedLevel = global.userChoices[userId];
    const scaleValue = levelMap[selectedLevel];
    
    try {
        const statusMsg = await bot.sendMessage(chatId, '📤 Uploading image...');
        
        // Update stats
        resetDailyStats();
        global.dailyStats.imagesProcessed++;
        global.dailyStats.qualityUsage[selectedLevel]++;
        
        // Update user stats in NocoDB
        await updateUserImageCount(userId, selectedLevel);
        
        // Get the highest resolution photo
        const photo = msg.photo[msg.photo.length - 1];
        const fileLink = await bot.getFileLink(photo.file_id);
        
        // Download image
        const response = await axios.get(fileLink, { responseType: 'stream' });
        const tempPath = path.join(__dirname, `temp_${userId}_${Date.now()}.jpg`);
        const writer = fs.createWriteStream(tempPath);
        response.data.pipe(writer);
        
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
        // Step 1: Upload to upscaler API
        const uploadUrl = "https://photoai.imglarger.com/api/PhoAi/Upload";
        const formData = new FormData();
        formData.append('file', fs.createReadStream(tempPath), {
            filename: 'image.jpg',
            contentType: 'image/jpeg'
        });
        formData.append('type', '2');
        formData.append('scaleRadio', scaleValue);
        
        const uploadHeaders = {
            ...formData.getHeaders(),
            "Origin": "https://image-enhancer-snowy.vercel.app",
            "Referer": "https://image-enhancer-snowy.vercel.app/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
        };
        
        const uploadRes = await axios.post(uploadUrl, formData, { headers: uploadHeaders });
        
        if (uploadRes.data.code !== 200) {
            throw new Error(`Upload failed: ${JSON.stringify(uploadRes.data)}`);
        }
        
        const code = uploadRes.data.data.code;
        const imgType = uploadRes.data.data.type;
        
        bot.editMessageText('⏳ Processing image...', {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
        
        // Step 2: Check status
        const checkUrl = "https://photoai.imglarger.com/api/PhoAi/CheckStatus";
        const payload = {
            code: code,
            type: String(imgType)
        };
        
        const statusHeaders = {
            "Origin": "https://image-enhancer-snowy.vercel.app",
            "Referer": "https://image-enhancer-snowy.vercel.app/",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
        };
        
        let upscaledUrl = null;
        
        for (let attempt = 0; attempt < 20; attempt++) {
            const statusRes = await axios.post(checkUrl, payload, { headers: statusHeaders });
            
            if (statusRes.status !== 200) {
                throw new Error(`Status check failed: ${statusRes.status}`);
            }
            
            const statusData = statusRes.data;
            const status = statusData.data?.status;
            
            if (status === 'success') {
                upscaledUrl = statusData.data.downloadUrls[0];
                break;
            } else if (status === 'waiting') {
                bot.editMessageText(`⌛ Still processing... (${attempt + 1}/20)`, {
                    chat_id: chatId,
                    message_id: statusMsg.message_id
                });
                await new Promise(resolve => setTimeout(resolve, 3000));
            } else {
                throw new Error(`Unknown status: ${JSON.stringify(statusData)}`);
            }
        }
        
        if (!upscaledUrl) {
            throw new Error('Upscale timed out');
        }
        
        bot.editMessageText('📥 Downloading result...', {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
        
        // Step 3: Download and send result
        const imageData = await axios.get(upscaledUrl, { responseType: 'stream' });
        const outputPath = path.join(__dirname, `WallSwipe_${selectedLevel}_${Date.now()}.jpg`);
        const outputWriter = fs.createWriteStream(outputPath);
        imageData.data.pipe(outputWriter);
        
        await new Promise((resolve, reject) => {
            outputWriter.on('finish', resolve);
            outputWriter.on('error', reject);
        });
        
        // Send the upscaled image
        await bot.sendDocument(chatId, outputPath, {
            caption: `✅ Upscaled with ${selectedLevel.toUpperCase()} quality!\n\n🔄 Send another image or use /quality to change quality.`
        }, {
            filename: `WallSwipe_${selectedLevel}.jpg`
        });
        
        // Clean up files
        fs.unlinkSync(tempPath);
        fs.unlinkSync(outputPath);
        
        // Delete status message
        bot.deleteMessage(chatId, statusMsg.message_id);
        
    } catch (error) {
        console.error('Error processing image:', error);
        bot.sendMessage(chatId, `❌ Failed to process image: ${error.message}`);
    }
});

// Handle documents (images sent as files)
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    
    // Track user
    await trackUser(user);
    
    if (msg.document.mime_type && msg.document.mime_type.startsWith('image/')) {
        // Convert document to photo-like object and process
        const photoLikeMsg = {
            ...msg,
            photo: [{
                file_id: msg.document.file_id,
                file_size: msg.document.file_size
            }]
        };
        
        // Remove document property to avoid confusion
        delete photoLikeMsg.document;
        
        // Process as photo
        bot.emit('photo', photoLikeMsg);
    } else {
        bot.sendMessage(chatId, '⚠️ Please send an image file (JPG, PNG, etc.)');
    }
});

// Handle any text message (for additional tracking)
bot.on('message', async (msg) => {
    // Skip if it's a command or photo (already handled)
    if (msg.text && msg.text.startsWith('/')) return;
    if (msg.photo || msg.document) return;
    
    const user = msg.from;
    
    // Track user interaction
    await trackUser(user);
});

// Handle errors
bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

bot.on('webhook_error', (error) => {
    console.error('Webhook error:', error);
});

// Initialize bot
async function initializeBot() {
    console.log('🤖 WallSwipe Image Upscaler Bot started!');
    
    // Send startup notification to admin
    if (ADMIN_USER_ID) {
        try {
            await bot.sendMessage(ADMIN_USER_ID, 
                `🚀 **Bot Started Successfully!**\n\n` +
                `📅 Time: ${new Date().toLocaleString()}\n` +
                `🔧 Environment: ${process.env.NODE_ENV || 'development'}\n` +
                `💾 NocoDB: ${NOCODB_CONFIG.BASE_URL ? '✅ Connected' : '❌ Not configured'}\n` +
                `📊 Stats tracking: ✅ Enabled\n` +
                `⏰ Daily reports: ✅ Scheduled for 9:00 AM UTC\n\n` +
                `Use /stats for instant statistics or /fullstats for detailed report.`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('Failed to send startup notification:', error);
        }
    }
    
    // Send initial stats if in production
    if (process.env.NODE_ENV === 'production' && ADMIN_USER_ID) {
        setTimeout(async () => {
            try {
                await sendDailyStatsToAdmin();
            } catch (error) {
                console.error('Failed to send initial stats:', error);
            }
        }, 5000); // Wait 5 seconds after startup
    }
}

// Start the bot
initializeBot();
