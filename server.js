// ============================================
// KR Bet - Telegram Mini App Server
// ============================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fetch = require('node-fetch');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// ============================================
// КОНФИГУРАЦИЯ
// ============================================
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-app.onrender.com';

// ============================================
// ХРАНИЛИЩЕ ДАННЫХ
// ============================================
const users = new Map();
const pendingPayments = new Map(); // paymentId -> { userId, amount, status }

// Roll game state
const rollGame = {
    phase: 'waiting',
    bets: [],
    timerSeconds: 30,
    timerInterval: null,
    winnerIndex: -1,
};

// Crash game state
const crashGame = {
    phase: 'waiting',
    multiplier: 1.00,
    maxMultiplier: 1.00,
    countdown: 5,
    bets: [],
    history: [],
};

// ============================================
// MIDDLEWARE
// ============================================
app.use(express.json());
app.use(express.static(__dirname));

// ============================================
// TELEGRAM AUTH
// ============================================

function validateTelegramInitData(initData) {
    if (!initData) return false;
    try {
        const data = new URLSearchParams(initData);
        const hash = data.get('hash');
        if (!hash) return false;
        data.delete('hash');

        const keys = [...data.keys()].sort();
        const dataCheckString = keys.map(key => `${key}=${data.get(key)}`).join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        return calculatedHash === hash;
    } catch (e) {
        return false;
    }
}

function getUserFromInitData(initData) {
    const data = new URLSearchParams(initData);
    const userStr = data.get('user');
    if (!userStr) return null;
    try {
        const user = JSON.parse(userStr);
        return {
            id: user.id,
            username: user.username || '',
            firstName: user.first_name || 'Player',
            lastName: user.last_name || '',
            photoUrl: user.photo_url || '',
        };
    } catch (e) {
        return null;
    }
}

function getOrCreateUser(userData) {
    if (!users.has(userData.id)) {
        users.set(userData.id, {
            id: userData.id,
            username: userData.username,
            firstName: userData.firstName,
            lastName: userData.lastName,
            photoUrl: userData.photoUrl,
            balance: 0,
            stats: { wins: 0, spent: 0, won: 0 },
            createdAt: Date.now(),
            lastActive: Date.now(),
        });
    } else {
        const user = users.get(userData.id);
        user.lastActive = Date.now();
        if (userData.username) user.username = userData.username;
        if (userData.photoUrl) user.photoUrl = userData.photoUrl;
    }
    return users.get(userData.id);
}

// ============================================
// API - БАЛАНС
// ============================================

app.get('/api/balance', (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData) {
        return res.json({ balance: 0, error: 'No init data' });
    }
    const userData = getUserFromInitData(initData);
    if (!userData) {
        return res.json({ balance: 0, error: 'Invalid user' });
    }
    const user = getOrCreateUser(userData);
    res.json({ balance: user.balance, stats: user.stats });
});

// ============================================
// API - ПОПОЛНЕНИЕ ЧЕРЕЗ TELEGRAM STARS
// ============================================

app.post('/api/deposit', async (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    const { amount } = req.body;

    if (!initData || !amount || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Неверные данные' });
    }

    const userData = getUserFromInitData(initData);
    if (!userData) {
        return res.status(401).json({ success: false, error: 'Неавторизован' });
    }

    const user = getOrCreateUser(userData);

    try {
        // Генерируем уникальный payload для платежа
        const paymentId = crypto.randomUUID();
        const payload = JSON.stringify({
            userId: user.id,
            paymentId,
            amount,
            type: 'deposit',
        });

        // Создаём инвойс в Telegram
        const invoiceResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `Пополнение ${amount} ⭐`,
                description: `Пополнение баланса KR Bet на ${amount} звезд`,
                payload: payload,
                currency: 'XTR',
                prices: [{ label: `${amount} звезд`, amount: amount }],
            }),
        });

        const invoiceData = await invoiceResponse.json();

        if (!invoiceData.ok) {
            console.error('Invoice error:', invoiceData);
            return res.status(500).json({ success: false, error: 'Ошибка создания платежа' });
        }

        // Сохраняем pending payment
        pendingPayments.set(paymentId, {
            userId: user.id,
            amount,
            status: 'pending',
            createdAt: Date.now(),
        });

        // Возвращаем ссылку на оплату
        res.json({
            success: true,
            invoiceLink: invoiceData.result,
        });
    } catch (e) {
        console.error('Deposit error:', e);
        res.status(500).json({ success: false, error: 'Серверная ошибка' });
    }
});

// ============================================
// WEBHOOK - ПОДТВЕРЖДЕНИЕ ПЛАТЕЖА ОТ TELEGRAM
// ============================================

app.post('/api/webhook/payment', async (req, res) => {
    const body = req.body;
    console.log('Payment webhook received:', JSON.stringify(body, null, 2));

    try {
        // Telegram отправляет update с pre_checkout_query или successful_payment
        if (body.message?.successful_payment) {
            const payment = body.message.successful_payment;
            const payload = JSON.parse(payment.invoice_payload);
            const { paymentId, userId, amount, type } = payload;

            if (type === 'deposit' && pendingPayments.has(paymentId)) {
                const pending = pendingPayments.get(paymentId);
                if (pending.status === 'pending') {
                    pending.status = 'completed';
                    
                    // Начисляем баланс ТОЛЬКО после подтверждения оплаты
                    const user = users.get(userId);
                    if (user) {
                        user.balance += amount;
                        console.log(`✅ Начислено ${amount} ⭐ пользователю ${userId}. Баланс: ${user.balance}`);
                    }
                }
            }
        }

        if (body.pre_checkout_query) {
            // Подтверждаем приём платежа
            const queryId = body.pre_checkout_query.id;
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pre_checkout_query_id: queryId,
                    ok: true,
                }),
            });
        }
    } catch (e) {
        console.error('Webhook error:', e);
    }

    res.sendStatus(200);
});

// ============================================
// API - ВЫВОД СРЕДСТВ
// ============================================

app.post('/api/withdraw', (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    const { amount } = req.body;

    if (!initData || !amount || amount < 100) {
        return res.status(400).json({ success: false, error: 'Минимальный вывод 100 ⭐' });
    }

    const userData = getUserFromInitData(initData);
    if (!userData) {
        return res.status(401).json({ success: false, error: 'Неавторизован' });
    }

    const user = getOrCreateUser(userData);
    if (user.balance < amount) {
        return res.status(400).json({ success: false, error: 'Недостаточно звезд на балансе' });
    }

    user.balance -= amount;

    // Здесь будет логика отправки звёзд через бота
    // sendMessage с звездами или sendInvoice обратно

    res.json({ 
        success: true, 
        balance: user.balance, 
        message: 'Заявка на вывод отправлена' 
    });
});

// ============================================
// GAME STATE API
// ============================================

app.get('/api/roll/state', (req, res) => {
    res.json(getRollPublicState());
});

app.get('/api/crash/state', (req, res) => {
    res.json(getCrashPublicState());
});

// ============================================
// SOCKET.IO
// ============================================

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    let currentUser = null;

    socket.on('auth', (initData) => {
        const userData = getUserFromInitData(initData);
        if (userData) {
            currentUser = getOrCreateUser(userData);
            socket.emit('auth:success', {
                balance: currentUser.balance,
                stats: currentUser.stats,
                user: { name: currentUser.firstName, photoUrl: currentUser.photoUrl },
            });
            socket.emit('roll:state', getRollPublicState());
            socket.emit('crash:state', getCrashPublicState());
        }
    });

    socket.on('roll:bet', (data) => {
        if (!currentUser) return;
        const amount = parseInt(data.amount);
        if (isNaN(amount) || amount < 10) return;
        if (rollGame.phase !== 'waiting') return;
        if (currentUser.balance < amount) return;
        if (rollGame.bets.some(b => b.userId === currentUser.id)) return;

        currentUser.balance -= amount;
        currentUser.stats.spent += amount;

        const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63','#00bcd4','#ff5722','#8bc34a','#3f51b5','#ff9800','#795548','#607d8b'];
        const usedColors = rollGame.bets.map(b => b.color);
        const available = colors.filter(c => !usedColors.includes(c));
        const color = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : '#c9a84c';

        rollGame.bets.push({
            userId: currentUser.id,
            name: currentUser.firstName || 'Player',
            amount,
            color,
        });

        socket.emit('balance:update', currentUser.balance);
        io.emit('roll:state', getRollPublicState());
    });

    socket.on('crash:bet', (data) => {
        if (!currentUser) return;
        const amount = parseInt(data.amount);
        if (isNaN(amount) || amount < 10) return;
        if (crashGame.phase !== 'waiting') return;
        if (currentUser.balance < amount) return;

        currentUser.balance -= amount;
        currentUser.stats.spent += amount;

        crashGame.bets.push({
            userId: currentUser.id,
            name: currentUser.firstName || 'Player',
            amount,
            cashedOut: false,
            cashoutMultiplier: 0,
        });

        socket.emit('balance:update', currentUser.balance);
        io.emit('crash:state', getCrashPublicState());
    });

    socket.on('crash:cashout', () => {
        if (!currentUser) return;
        if (crashGame.phase !== 'flying') return;
        const bet = crashGame.bets.find(b => b.userId === currentUser.id && !b.cashedOut);
        if (!bet) return;

        bet.cashedOut = true;
        bet.cashoutMultiplier = crashGame.multiplier;
        const win = Math.floor(bet.amount * crashGame.multiplier);
        currentUser.balance += win;
        currentUser.stats.wins++;
        currentUser.stats.won += win - bet.amount;

        socket.emit('balance:update', currentUser.balance);
        socket.emit('crash:cashedOut', { win, multiplier: crashGame.multiplier });
        io.emit('crash:state', getCrashPublicState());
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// ============================================
// ROLL GAME LOOP
// ============================================

function getRollPublicState() {
    return {
        phase: rollGame.phase,
        timerSeconds: rollGame.timerSeconds,
        bets: rollGame.bets.map(b => ({ name: b.name, amount: b.amount, color: b.color })),
        totalBank: rollGame.bets.reduce((sum, b) => sum + b.amount, 0),
    };
}

function startRollTimer() {
    rollGame.phase = 'waiting';
    rollGame.timerSeconds = 30;
    rollGame.bets = [];
    rollGame.winnerIndex = -1;
    io.emit('roll:state', getRollPublicState());

    if (rollGame.timerInterval) clearInterval(rollGame.timerInterval);
    rollGame.timerInterval = setInterval(() => {
        rollGame.timerSeconds--;
        if (rollGame.timerSeconds <= 0) {
            clearInterval(rollGame.timerInterval);
            startRollSpin();
        }
        io.emit('roll:timer', rollGame.timerSeconds);
    }, 1000);
}

function startRollSpin() {
    if (rollGame.bets.length === 0) {
        setTimeout(() => startRollTimer(), 600);
        return;
    }
    rollGame.phase = 'spinning';
    io.emit('roll:state', getRollPublicState());

    const totalBank = rollGame.bets.reduce((sum, b) => sum + b.amount, 0);
    let random = Math.random() * totalBank;
    let winnerIndex = 0;
    for (let i = 0; i < rollGame.bets.length; i++) {
        random -= rollGame.bets[i].amount;
        if (random <= 0) { winnerIndex = i; break; }
    }
    rollGame.winnerIndex = winnerIndex;
    const winner = rollGame.bets[winnerIndex];

    setTimeout(() => {
        rollGame.phase = 'result';
        const user = users.get(winner.userId);
        if (user) {
            user.balance += totalBank;
            user.stats.wins++;
            user.stats.won += totalBank;
        }
        io.emit('roll:result', { winnerName: winner.name, winnerAmount: totalBank, winnerIndex });
        io.emit('roll:state', getRollPublicState());
        setTimeout(() => startRollTimer(), 2200);
    }, 4200);
}

// ============================================
// CRASH GAME LOOP
// ============================================

function getCrashPublicState() {
    return {
        phase: crashGame.phase,
        multiplier: crashGame.multiplier,
        countdown: crashGame.countdown,
        bets: crashGame.bets.map(b => ({ name: b.name, amount: b.amount })),
        history: crashGame.history,
    };
}

function startCrashTimer() {
    crashGame.phase = 'waiting';
    crashGame.countdown = 5;
    crashGame.bets = [];
    crashGame.multiplier = 1.00;
    io.emit('crash:state', getCrashPublicState());

    let countdown = 5;
    const interval = setInterval(() => {
        countdown--;
        if (countdown <= 0) {
            clearInterval(interval);
            startCrashFlight();
        }
        io.emit('crash:countdown', countdown);
    }, 1000);
}

function startCrashFlight() {
    crashGame.phase = 'flying';
    crashGame.multiplier = 1.00;
    const r = Math.random();
    if (r < 0.40) crashGame.maxMultiplier = 1.01 + Math.random() * 0.7;
    else if (r < 0.70) crashGame.maxMultiplier = 1.2 + Math.random() * 1.3;
    else if (r < 0.90) crashGame.maxMultiplier = 2.0 + Math.random() * 2.5;
    else crashGame.maxMultiplier = 3.5 + Math.random() * 6;

    const startTime = Date.now();
    io.emit('crash:state', getCrashPublicState());

    const interval = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000;
        crashGame.multiplier = Math.pow(Math.E, elapsed * 0.12);
        if (crashGame.multiplier >= crashGame.maxMultiplier) {
            crashGame.multiplier = crashGame.maxMultiplier;
            clearInterval(interval);
            crashNow();
            return;
        }
        io.emit('crash:tick', crashGame.multiplier);
    }, 50);
}

function crashNow() {
    crashGame.phase = 'crashed';
    crashGame.crashedAt = crashGame.multiplier;
    crashGame.history.unshift(crashGame.multiplier);
    if (crashGame.history.length > 15) crashGame.history.pop();

    crashGame.bets.forEach(bet => {
        if (!bet.cashedOut) {
            const user = users.get(bet.userId);
            if (user) user.stats.spent += bet.amount;
        }
    });

    io.emit('crash:crash', crashGame.multiplier);
    io.emit('crash:state', getCrashPublicState());
    setTimeout(() => startCrashTimer(), 5000);
}

// ============================================
// ЗАПУСК
// ============================================
startRollTimer();
startCrashTimer();

server.listen(PORT, () => {
    console.log(`🚀 KR Bet server running on port ${PORT}`);
    console.log(`📍 WebApp URL: ${WEBAPP_URL}`);
    console.log(`🤖 Bot Token: ${BOT_TOKEN ? 'Configured' : 'NOT CONFIGURED'}`);
    console.log(`⚠️  Don't forget to set webhook: https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${WEBAPP_URL}/api/webhook/payment`);
});