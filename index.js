const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_USERNAME = '@WallSwipe';
const PORT = process.env.PORT || 3000;

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

// Start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
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

// Handle callback queries
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;
    
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
            caption: `✅ Upscaled with ${selectedLevel.toUpperCase()} quality!\n\n🔄 Send another image or /start to change quality.`
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

// Handle errors
bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

bot.on('webhook_error', (error) => {
    console.error('Webhook error:', error);
});

console.log('🤖 WallSwipe Image Upscaler Bot started!');
