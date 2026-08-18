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
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://krbet.onrender.com';

// ============================================
// ХРАНИЛИЩЕ
// ============================================
const users = new Map();
const pendingPayments = new Map();
const onlineUsers = new Map();

const rollGame = {
    phase: 'waiting',
    bets: [],
    timerSeconds: 30,
    timerInterval: null,
    winnerIndex: -1,
    forcedWinner: null,
    winnerData: null,
    spinAngle: 0,
    spinSpins: 0,
    spinDuration: 0,
};

const crashGame = {
    phase: 'waiting',
    multiplier: 1.00,
    maxMultiplier: 1.00,
    countdown: 5,
    bets: [],
    history: [],
    forcedMultiplier: null,
    forceCrashNow: false,
    crashInterval: null,
    countdownInterval: null,
    startedAt: 0,
};

app.use(express.json());
app.use(express.static(__dirname));

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
    } catch (e) { return null; }
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
        users.get(userData.id).lastActive = Date.now();
    }
    return users.get(userData.id);
}

// ============ API ============

app.get('/api/balance', (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData) return res.json({ balance: 0 });
    const userData = getUserFromInitData(initData);
    if (!userData) return res.json({ balance: 0 });
    const user = getOrCreateUser(userData);
    res.json({ balance: user.balance, stats: user.stats });
});

app.post('/api/deposit', async (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    const { amount } = req.body;
    if (!initData || !amount || amount <= 0) return res.status(400).json({ success: false });
    const userData = getUserFromInitData(initData);
    if (!userData) return res.status(401).json({ success: false });
    getOrCreateUser(userData);
    try {
        const paymentId = crypto.randomUUID();
        const payload = JSON.stringify({ userId: userData.id, paymentId, amount, type: 'deposit' });
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
        if (!invoiceData.ok) return res.status(500).json({ success: false, error: 'Ошибка создания платежа' });
        pendingPayments.set(paymentId, { userId: userData.id, amount, status: 'pending' });
        res.json({ success: true, invoiceLink: invoiceData.result });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/webhook/payment', async (req, res) => {
    const body = req.body;
    try {
        if (body.message?.successful_payment) {
            const payment = body.message.successful_payment;
            const payload = JSON.parse(payment.invoice_payload);
            const { paymentId, userId, amount } = payload;
            if (pendingPayments.has(paymentId)) {
                const pending = pendingPayments.get(paymentId);
                if (pending.status === 'pending') {
                    pending.status = 'completed';
                    const user = users.get(userId);
                    if (user) {
                        user.balance += amount;
                        onlineUsers.forEach((uid, socketId) => {
                            if (uid === userId) io.to(socketId).emit('balance:update', user.balance);
                        });
                    }
                }
            }
        }
        if (body.pre_checkout_query) {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pre_checkout_query_id: body.pre_checkout_query.id, ok: true }),
            });
        }
    } catch (e) {}
    res.sendStatus(200);
});

app.post('/api/withdraw', (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    const { amount } = req.body;
    if (!initData || !amount || amount < 100) return res.status(400).json({ success: false });
    const userData = getUserFromInitData(initData);
    if (!userData) return res.status(401).json({ success: false });
    const user = getOrCreateUser(userData);
    if (user.balance < amount) return res.status(400).json({ success: false });
    user.balance -= amount;
    res.json({ success: true, balance: user.balance });
});

// ============ АДМИН ============

app.get('/api/admin/players', (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData) return res.status(401).json({ success: false });
    const players = [];
    const uniqueIds = new Set();
    onlineUsers.forEach((userId) => {
        if (uniqueIds.has(userId)) return;
        uniqueIds.add(userId);
        const user = users.get(userId);
        if (user) players.push({ userId: user.id, name: user.firstName || 'Player', username: user.username, balance: user.balance });
    });
    const adminData = getUserFromInitData(initData);
    if (adminData && !uniqueIds.has(adminData.id)) {
        const admin = getOrCreateUser(adminData);
        players.push({ userId: admin.id, name: admin.firstName + ' (Вы)', username: admin.username, balance: admin.balance });
    }
    res.json({ success: true, players });
});

app.post('/api/admin/set-balance', (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    const { userId, action, amount } = req.body;
    if (!initData || !userId || !action || !amount) return res.status(400).json({ success: false });
    const numericUserId = parseInt(userId);
    const user = users.get(numericUserId);
    if (!user) return res.status(404).json({ success: false });
    if (action === 'add') user.balance += amount;
    else if (action === 'sub') user.balance -= amount;
    onlineUsers.forEach((uid, socketId) => {
        if (uid === numericUserId) io.to(socketId).emit('balance:update', user.balance);
    });
    res.json({ success: true, balance: user.balance });
});

app.post('/api/admin/force-roll-winner', (req, res) => {
    const { userId } = req.body;
    rollGame.forcedWinner = userId ? parseInt(userId) : null;
    res.json({ success: true });
});

app.post('/api/admin/force-crash-multiplier', (req, res) => {
    const { multiplier } = req.body;
    crashGame.forcedMultiplier = multiplier ? parseFloat(multiplier) : null;
    res.json({ success: true });
});

app.post('/api/admin/crash-now', (req, res) => {
    crashGame.forceCrashNow = true;
    res.json({ success: true });
});

app.get('/api/roll/state', (req, res) => res.json(getRollPublicState()));
app.get('/api/crash/state', (req, res) => res.json(getCrashPublicState()));

// ============ SOCKET.IO ============

io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('auth', (initData) => {
        const userData = getUserFromInitData(initData);
        if (userData) {
            currentUser = getOrCreateUser(userData);
            onlineUsers.set(socket.id, currentUser.id);
            socket.emit('auth:success', {
                balance: currentUser.balance,
                stats: currentUser.stats,
                user: { id: currentUser.id, name: currentUser.firstName, photoUrl: currentUser.photoUrl },
            });
            socket.emit('roll:state', getRollPublicState());
            socket.emit('roll:timer', rollGame.timerSeconds);
            socket.emit('crash:state', getCrashPublicState());
            socket.emit('crash:tick', crashGame.multiplier);
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

        rollGame.bets.push({ userId: currentUser.id, name: currentUser.firstName || 'Player', amount, color });
        socket.emit('balance:update', currentUser.balance);
        socket.emit('stats:update', currentUser.stats);
        io.emit('roll:state', getRollPublicState());
    });

    socket.on('crash:bet', (data) => {
        if (!currentUser) return;
        const amount = parseInt(data.amount);
        if (isNaN(amount) || amount < 10) return;
        if (crashGame.phase !== 'waiting') return;
        if (currentUser.balance < amount) return;
        if (crashGame.bets.some(b => b.userId === currentUser.id)) return;

        currentUser.balance -= amount;
        currentUser.stats.spent += amount;

        crashGame.bets.push({ userId: currentUser.id, name: currentUser.firstName || 'Player', amount, cashedOut: false, cashoutMultiplier: 0 });

        socket.emit('balance:update', currentUser.balance);
        socket.emit('stats:update', currentUser.stats);
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
        socket.emit('stats:update', currentUser.stats);
        socket.emit('crash:cashedOut', { win, multiplier: crashGame.multiplier, userId: currentUser.id });
        io.emit('crash:state', getCrashPublicState());
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.id);
    });
});

// ============ ROLL LOOP ============

function getRollPublicState() {
    return {
        phase: rollGame.phase,
        timerSeconds: rollGame.timerSeconds,
        bets: rollGame.bets.map(b => ({ userId: b.userId, name: b.name, amount: b.amount, color: b.color })),
        totalBank: rollGame.bets.reduce((sum, b) => sum + b.amount, 0),
        winnerIndex: rollGame.winnerIndex,
        winnerData: rollGame.winnerData,
        spinAngle: rollGame.spinAngle,
        spinSpins: rollGame.spinSpins,
        spinDuration: rollGame.spinDuration,
    };
}

function startRollTimer() {
    rollGame.phase = 'waiting';
    rollGame.timerSeconds = 30;
    rollGame.bets = [];
    rollGame.winnerIndex = -1;
    rollGame.winnerData = null;
    rollGame.forcedWinner = null;
    rollGame.spinAngle = 0;
    rollGame.spinSpins = 0;
    rollGame.spinDuration = 0;
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
    if (rollGame.bets.length === 0) { setTimeout(() => startRollTimer(), 600); return; }
    rollGame.phase = 'spinning';
    rollGame.winnerData = null;

    const totalBank = rollGame.bets.reduce((sum, b) => sum + b.amount, 0);
    let winnerIndex;

    if (rollGame.forcedWinner) {
        winnerIndex = rollGame.bets.findIndex(b => b.userId === rollGame.forcedWinner);
        if (winnerIndex === -1) winnerIndex = Math.floor(Math.random() * rollGame.bets.length);
    } else {
        let random = Math.random() * totalBank;
        winnerIndex = 0;
        for (let i = 0; i < rollGame.bets.length; i++) {
            random -= rollGame.bets[i].amount;
            if (random <= 0) { winnerIndex = i; break; }
        }
    }

    rollGame.winnerIndex = winnerIndex;

    let cumulativeAngle = 0;
    let winnerStartAngle = 0;
    let winnerSweep = 0;
    for (let i = 0; i < rollGame.bets.length; i++) {
        const sweep = (rollGame.bets[i].amount / totalBank) * 360;
        if (i === winnerIndex) {
            winnerStartAngle = cumulativeAngle;
            winnerSweep = sweep;
            break;
        }
        cumulativeAngle += sweep;
    }
    const randomInSector = Math.random() * winnerSweep;
    const targetAngle = winnerStartAngle + randomInSector;
    
    const spins = 5 + Math.floor(Math.random() * 6);
    const duration = 3800 + Math.random() * 800;
    const totalRotation = spins * 360 + (360 - targetAngle);
    
    rollGame.spinAngle = totalRotation;
    rollGame.spinSpins = spins;
    rollGame.spinDuration = duration;

    io.emit('roll:state', getRollPublicState());

    const winner = rollGame.bets[winnerIndex];

    setTimeout(() => {
        rollGame.phase = 'result';
        const user = users.get(winner.userId);
        if (user) {
            user.balance += totalBank;
            user.stats.wins++;
            user.stats.won += totalBank;
            onlineUsers.forEach((uid, socketId) => {
                if (uid === winner.userId) {
                    io.to(socketId).emit('balance:update', user.balance);
                    io.to(socketId).emit('stats:update', user.stats);
                }
            });
        }
        rollGame.winnerData = { winnerName: winner.name, winnerAmount: totalBank, winnerIndex };
        io.emit('roll:result', rollGame.winnerData);
        io.emit('roll:state', getRollPublicState());
        setTimeout(() => startRollTimer(), 2200);
    }, duration);
}

// ============ CRASH LOOP ============

function getCrashPublicState() {
    return {
        phase: crashGame.phase,
        multiplier: crashGame.multiplier,
        countdown: crashGame.countdown,
        bets: crashGame.bets.map(b => ({ userId: b.userId, name: b.name, amount: b.amount, cashedOut: b.cashedOut, cashoutMultiplier: b.cashoutMultiplier })),
        history: crashGame.history,
        startedAt: crashGame.startedAt,
    };
}

function startCrashTimer() {
    crashGame.phase = 'waiting';
    crashGame.countdown = 5;
    crashGame.bets = [];
    crashGame.multiplier = 1.00;
    crashGame.forcedMultiplier = null;
    crashGame.forceCrashNow = false;
    io.emit('crash:state', getCrashPublicState());

    let countdown = 5;
    if (crashGame.countdownInterval) clearInterval(crashGame.countdownInterval);
    crashGame.countdownInterval = setInterval(() => {
        countdown--;
        if (countdown <= 0) {
            clearInterval(crashGame.countdownInterval);
            startCrashFlight();
        }
        crashGame.countdown = countdown;
        io.emit('crash:countdown', countdown);
    }, 1000);
}

function startCrashFlight() {
    crashGame.phase = 'flying';
    crashGame.multiplier = 1.00;

    if (crashGame.forcedMultiplier) {
        crashGame.maxMultiplier = crashGame.forcedMultiplier;
    } else {
        const r = Math.random();
        if (r < 0.40) crashGame.maxMultiplier = 1.01 + Math.random() * 0.7;
        else if (r < 0.70) crashGame.maxMultiplier = 1.2 + Math.random() * 1.3;
        else if (r < 0.90) crashGame.maxMultiplier = 2.0 + Math.random() * 2.5;
        else crashGame.maxMultiplier = 3.5 + Math.random() * 6;
    }

    crashGame.startedAt = Date.now();
    io.emit('crash:state', getCrashPublicState());

    if (crashGame.crashInterval) clearInterval(crashGame.crashInterval);
    crashGame.crashInterval = setInterval(() => {
        const elapsed = (Date.now() - crashGame.startedAt) / 1000;
        crashGame.multiplier = Math.pow(Math.E, elapsed * 0.12);

        if (crashGame.forceCrashNow || crashGame.multiplier >= crashGame.maxMultiplier) {
            clearInterval(crashGame.crashInterval);
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

startRollTimer();
startCrashTimer();

server.listen(PORT, () => {
    console.log(`🚀 KR Bet server running on port ${PORT}`);
});
