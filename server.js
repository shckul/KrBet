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
    spinDuration: 0,
    finalAngle: 0,
    currentAngle: 0, // Текущий угол стрелки на сервере
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

const iceGame = {
    phase: 'waiting',
    timerSeconds: 30,
    bets: [],
    totalBank: 0,
    timerInterval: null,
    puckX: 170,
    puckY: 170,
    puckVX: 0,
    puckVY: 0,
    puckAnimation: null,
    winnerData: null,
};

const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63','#00bcd4','#ff5722','#8bc34a','#3f51b5','#ff9800','#795548','#607d8b'];

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
            history: [],
            createdAt: Date.now(),
            lastActive: Date.now(),
        });
    } else {
        users.get(userData.id).lastActive = Date.now();
    }
    return users.get(userData.id);
}

function addHistory(user, action, amount, type) {
    user.history.unshift({ action, amount, type, time: Date.now() });
    if (user.history.length > 50) user.history.pop();
}

app.get('/api/balance', (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData) return res.json({ balance: 0 });
    const userData = getUserFromInitData(initData);
    if (!userData) return res.json({ balance: 0 });
    const user = getOrCreateUser(userData);
    res.json({ balance: user.balance, stats: user.stats, history: user.history });
});

app.post('/api/deposit', async (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    const { amount } = req.body;
    if (!initData || !amount || amount <= 0) return res.status(400).json({ success: false });
    const userData = getUserFromInitData(initData);
    if (!userData) return res.status(401).json({ success: false });
    const user = getOrCreateUser(userData);
    try {
        const paymentId = crypto.randomUUID();
        const payload = JSON.stringify({ userId: user.id, paymentId, amount, type: 'deposit' });
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
        pendingPayments.set(paymentId, { userId: user.id, amount, status: 'pending' });
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
    addHistory(user, 'Вывод средств', amount, 'bet');
    res.json({ success: true, balance: user.balance });
});

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
                history: currentUser.history,
                user: { id: currentUser.id, name: currentUser.firstName, photoUrl: currentUser.photoUrl },
            });
            socket.emit('roll:state', getRollPublicState());
            socket.emit('roll:timer', rollGame.timerSeconds);
            socket.emit('crash:state', getCrashPublicState());
            socket.emit('crash:tick', crashGame.multiplier);
            socket.emit('ice:state', getIcePublicState());
            socket.emit('ice:timer', iceGame.timerSeconds);
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
        addHistory(currentUser, 'Игровая ставка (Рулетка)', amount, 'bet');

        const usedColors = rollGame.bets.map(b => b.color);
        const available = colors.filter(c => !usedColors.includes(c));
        const color = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : '#c9a84c';

        rollGame.bets.push({ userId: currentUser.id, name: currentUser.firstName || 'Player', amount, color });
        socket.emit('balance:update', currentUser.balance);
        socket.emit('stats:update', currentUser.stats);
        socket.emit('history:update', currentUser.history);
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
        addHistory(currentUser, 'Игровая ставка (Crash)', amount, 'bet');

        crashGame.bets.push({ userId: currentUser.id, name: currentUser.firstName || 'Player', amount, cashedOut: false, cashoutMultiplier: 0 });

        socket.emit('balance:update', currentUser.balance);
        socket.emit('stats:update', currentUser.stats);
        socket.emit('history:update', currentUser.history);
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
        addHistory(currentUser, 'Игровой выигрыш (Crash)', win, 'win');

        socket.emit('balance:update', currentUser.balance);
        socket.emit('stats:update', currentUser.stats);
        socket.emit('history:update', currentUser.history);
        socket.emit('crash:cashedOut', { win, multiplier: crashGame.multiplier, userId: currentUser.id });
        io.emit('crash:state', getCrashPublicState());
    });

    socket.on('mines:bet', (data) => {
        if (!currentUser) return;
        const amount = parseInt(data.amount);
        if (isNaN(amount) || amount < 10) return;
        if (currentUser.balance < amount) return;

        currentUser.balance -= amount;
        currentUser.stats.spent += amount;
        addHistory(currentUser, 'Игровая ставка (Mines)', amount, 'bet');
        socket.emit('balance:update', currentUser.balance);
        socket.emit('stats:update', currentUser.stats);
        socket.emit('history:update', currentUser.history);
    });

    socket.on('mines:win', (data) => {
        if (!currentUser) return;
        const win = parseInt(data.win);
        if (isNaN(win) || win <= 0) return;

        currentUser.balance += win;
        currentUser.stats.wins++;
        currentUser.stats.won += win;
        addHistory(currentUser, 'Игровой выигрыш (Mines)', win, 'win');
        socket.emit('balance:update', currentUser.balance);
        socket.emit('stats:update', currentUser.stats);
        socket.emit('history:update', currentUser.history);
    });

    socket.on('mines:lose', (data) => {
        if (!currentUser) return;
        const amount = parseInt(data.amount);
        if (isNaN(amount) || amount <= 0) return;
        currentUser.stats.spent += amount;
        socket.emit('stats:update', currentUser.stats);
    });

    socket.on('upgrader:play', (data) => {
    if (!currentUser) return;
    const bet = parseInt(data.bet);
    const target = parseInt(data.target);
    if (isNaN(bet) || isNaN(target) || bet < 10 || target <= bet) return;
    if (currentUser.balance < bet) return;

    const chance = bet / target;
    if (chance > 0.75) return;

    // Сразу списываем ставку
    currentUser.balance -= bet;
    currentUser.stats.spent += bet;
    addHistory(currentUser, 'Ставка (Upgrader)', bet, 'bet');
    socket.emit('balance:update', currentUser.balance);
    socket.emit('stats:update', currentUser.stats);
    socket.emit('history:update', currentUser.history);

    // Определяем результат, но НЕ начисляем сразу
    const won = Math.random() < chance;
    const winAmount = won ? target : 0;
    
    // Вычисляем угол для анимации
    const winSectorSize = chance * 360;
    let targetAngle;
    if (won) {
        targetAngle = Math.random() * winSectorSize;
    } else {
        targetAngle = winSectorSize + Math.random() * (360 - winSectorSize);
    }
    
    socket.emit('upgrader:angle', { targetAngle, duration: 3000 + Math.random() * 1000 });

    // Начисляем выигрыш ТОЛЬКО после анимации (через 3.5 секунды)
    setTimeout(() => {
        if (won) {
            currentUser.balance += target;
            currentUser.stats.wins++;
            currentUser.stats.won += target;
            addHistory(currentUser, 'Выигрыш (Upgrader)', target, 'win');
            
            // Отправляем обновлённый баланс
            socket.emit('balance:update', currentUser.balance);
            socket.emit('stats:update', currentUser.stats);
            socket.emit('history:update', currentUser.history);
        }
        
        // Отправляем результат
        socket.emit('upgrader:result', { userId: currentUser.id, won, winAmount, betAmount: bet });
    }, 3500);
});

    socket.on('ice:bet', (data) => {
        if (!currentUser) return;
        const amount = parseInt(data.amount);
        if (isNaN(amount) || amount < 10) return;
        if (iceGame.phase !== 'waiting') return;
        if (currentUser.balance < amount) return;
        if (iceGame.bets.some(b => b.userId === currentUser.id)) return;

        currentUser.balance -= amount;
        currentUser.stats.spent += amount;
        addHistory(currentUser, 'Ставка (Ice Arena)', amount, 'bet');

        const usedColors = iceGame.bets.map(b => b.color);
        const available = colors.filter(c => !usedColors.includes(c));
        const color = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : '#c9a84c';

        iceGame.bets.push({ userId: currentUser.id, name: currentUser.firstName || 'Player', amount, color });
        iceGame.totalBank += amount;

        socket.emit('balance:update', currentUser.balance);
        socket.emit('stats:update', currentUser.stats);
        socket.emit('history:update', currentUser.history);
        io.emit('ice:state', getIcePublicState());
    });

    socket.on('case:open', (data) => {
        if (!currentUser) return;
        const caseId = data.caseId;
        const casesData = {
            trash: { price: 10 },
            farmer: { price: 30 },
            funny: { price: 67 },
            okup: { price: 150 },
            star: { price: 500 }
        };
        const caseInfo = casesData[caseId];
        if (!caseInfo) return;
        if (currentUser.balance < caseInfo.price) return;

        currentUser.balance -= caseInfo.price;
        currentUser.stats.spent += caseInfo.price;
        addHistory(currentUser, 'Покупка кейса ' + caseId, caseInfo.price, 'bet');
        socket.emit('balance:update', currentUser.balance);
        socket.emit('stats:update', currentUser.stats);
        socket.emit('history:update', currentUser.history);
    });

    socket.on('case:win', (data) => {
        if (!currentUser) return;
        const amount = parseInt(data.amount);
        if (isNaN(amount) || amount <= 0) return;

        currentUser.balance += amount;
        currentUser.stats.wins++;
        currentUser.stats.won += amount;
        addHistory(currentUser, 'Выигрыш в кейсе', amount, 'win');
        socket.emit('balance:update', currentUser.balance);
        socket.emit('stats:update', currentUser.stats);
        socket.emit('history:update', currentUser.history);
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
        spinDuration: rollGame.spinDuration,
        finalAngle: rollGame.finalAngle,
        currentAngle: rollGame.currentAngle,
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
    rollGame.spinDuration = 0;
    rollGame.finalAngle = 0;
    rollGame.currentAngle = 0; // Сбрасываем стрелку на верх
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
    
    // ВАЖНО: Сектора на клиенте рисуются от ВЕРХА по часовой стрелке
    // Угол 0 = верх, угол 90 = право, угол 180 = низ, угол 270 = лево
    
    let finalAngleDeg;
    let winnerIndex;
    
    if (rollGame.forcedWinner) {
        // Админ выбрал победителя
        winnerIndex = rollGame.bets.findIndex(b => b.userId === rollGame.forcedWinner);
        if (winnerIndex === -1) winnerIndex = 0;
        
        // Вычисляем границы сектора победителя (от верха, по часовой)
        let cumulative = 0;
        for (let i = 0; i < winnerIndex; i++) {
            cumulative += (rollGame.bets[i].amount / totalBank) * 360;
        }
        const winnerSweep = (rollGame.bets[winnerIndex].amount / totalBank) * 360;
        finalAngleDeg = cumulative + Math.random() * winnerSweep;
    } else {
        // Случайный угол
        finalAngleDeg = Math.random() * 360;
        
        // Находим победителя по этому углу
        let cumulative = 0;
        winnerIndex = 0;
        for (let i = 0; i < rollGame.bets.length; i++) {
            const sweep = (rollGame.bets[i].amount / totalBank) * 360;
            if (finalAngleDeg >= cumulative && finalAngleDeg < cumulative + sweep) {
                winnerIndex = i;
                break;
            }
            cumulative += sweep;
        }
    }
    
    rollGame.winnerIndex = winnerIndex;
    rollGame.finalAngle = finalAngleDeg;
    
    const winner = rollGame.bets[winnerIndex];
    
    // Стрелка начинает с currentAngle (должен быть 0 после сброса)
    // Стрелка должна остановиться на finalAngleDeg
    const spins = 5 + Math.floor(Math.random() * 6);
    const duration = 3800 + Math.random() * 800;
    const totalRotation = spins * 360 + finalAngleDeg;
    
    rollGame.spinAngle = totalRotation;
    rollGame.spinDuration = duration;

    io.emit('roll:state', getRollPublicState());

    setTimeout(() => {
        rollGame.phase = 'result';
        rollGame.currentAngle = finalAngleDeg; // Сохраняем текущий угол
        const user = users.get(winner.userId);
        if (user) {
            user.balance += totalBank;
            user.stats.wins++;
            user.stats.won += totalBank;
            addHistory(user, 'Игровой выигрыш (Рулетка)', totalBank, 'win');
            onlineUsers.forEach((uid, socketId) => {
                if (uid === winner.userId) {
                    io.to(socketId).emit('balance:update', user.balance);
                    io.to(socketId).emit('stats:update', user.stats);
                    io.to(socketId).emit('history:update', user.history);
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
            if (user) {
                user.stats.spent += bet.amount;
                addHistory(user, 'Игровая ставка (Crash)', bet.amount, 'bet');
            }
        }
    });

    io.emit('crash:crash', crashGame.multiplier);
    io.emit('crash:state', getCrashPublicState());
    setTimeout(() => startCrashTimer(), 5000);
}

// ============ ICE ARENA ============

function getIcePublicState() {
    return {
        phase: iceGame.phase,
        timerSeconds: iceGame.timerSeconds,
        bets: iceGame.bets.map(b => ({ userId: b.userId, name: b.name, amount: b.amount, color: b.color })),
        totalBank: iceGame.totalBank,
        puckX: iceGame.puckX,
        puckY: iceGame.puckY,
    };
}

function startIceTimer() {
    iceGame.phase = 'waiting';
    iceGame.timerSeconds = 30;
    iceGame.bets = [];
    iceGame.totalBank = 0;
    iceGame.winnerData = null;
    iceGame.puckX = 170;
    iceGame.puckY = 170;
    iceGame.puckVX = 0;
    iceGame.puckVY = 0;
    io.emit('ice:state', getIcePublicState());

    if (iceGame.timerInterval) clearInterval(iceGame.timerInterval);
    iceGame.timerInterval = setInterval(() => {
        iceGame.timerSeconds--;
        if (iceGame.timerSeconds <= 0) {
            clearInterval(iceGame.timerInterval);
            startIceLaunch();
        }
        io.emit('ice:timer', iceGame.timerSeconds);
    }, 1000);
}

function startIceLaunch() {
    if (iceGame.bets.length === 0) { setTimeout(() => startIceTimer(), 600); return; }
    iceGame.phase = 'launching';
    io.emit('ice:state', getIcePublicState());

    const finalAngle = Math.random() * 360;
    
    setTimeout(() => {
        launchIcePuck(finalAngle);
    }, 1000);
}

function launchIcePuck(angle) {
    iceGame.phase = 'sliding';
    iceGame.puckX = 170;
    iceGame.puckY = 170;
    
    // Увеличиваем начальную скорость до 14
    const speed = 14;
    const rad = angle * Math.PI / 180;
    iceGame.puckVX = Math.cos(rad) * speed;
    iceGame.puckVY = Math.sin(rad) * speed;
    
    const MIN_POS = 10;
    const MAX_POS = 330;
    
    if (iceGame.puckAnimation) clearInterval(iceGame.puckAnimation);
    
    iceGame.puckAnimation = setInterval(() => {
        iceGame.puckX += iceGame.puckVX;
        iceGame.puckY += iceGame.puckVY;
        
        // Отскок от стенок с сохранением энергии
        if (iceGame.puckX < MIN_POS) {
            iceGame.puckX = MIN_POS;
            iceGame.puckVX = Math.abs(iceGame.puckVX) * 0.85;
        } else if (iceGame.puckX > MAX_POS) {
            iceGame.puckX = MAX_POS;
            iceGame.puckVX = -Math.abs(iceGame.puckVX) * 0.85;
        }
        
        if (iceGame.puckY < MIN_POS) {
            iceGame.puckY = MIN_POS;
            iceGame.puckVY = Math.abs(iceGame.puckVY) * 0.85;
        } else if (iceGame.puckY > MAX_POS) {
            iceGame.puckY = MAX_POS;
            iceGame.puckVY = -Math.abs(iceGame.puckVY) * 0.85;
        }
        
        // Плавное трение — очень медленное в начале, быстрее в конце
        const currentSpeed = Math.sqrt(iceGame.puckVX * iceGame.puckVX + iceGame.puckVY * iceGame.puckVY);
        
        if (currentSpeed > 8) {
            // Очень быстрая фаза — почти нет трения
            iceGame.puckVX *= 0.999;
            iceGame.puckVY *= 0.999;
        } else if (currentSpeed > 4) {
            // Быстрая фаза — слабое трение
            iceGame.puckVX *= 0.997;
            iceGame.puckVY *= 0.997;
        } else if (currentSpeed > 2) {
            // Средняя фаза — умеренное трение
            iceGame.puckVX *= 0.995;
            iceGame.puckVY *= 0.995;
        } else if (currentSpeed > 1) {
            // Медленная фаза — заметное трение
            iceGame.puckVX *= 0.99;
            iceGame.puckVY *= 0.99;
        } else {
            // Очень медленная — плавное торможение
            iceGame.puckVX *= 0.97;
            iceGame.puckVY *= 0.97;
        }
        
        io.emit('ice:puck', { x: iceGame.puckX, y: iceGame.puckY });
        
        // Остановка при очень малой скорости
        if (Math.abs(iceGame.puckVX) < 0.02 && Math.abs(iceGame.puckVY) < 0.02) {
            clearInterval(iceGame.puckAnimation);
            finishIceRound();
        }
    }, 16);
}
function finishIceRound() {
    iceGame.phase = 'result';
    
    const relativeX = Math.max(0, Math.min(1, iceGame.puckX / 340));
    let cumulative = 0;
    let winner = iceGame.bets[0];
    
    for (const bet of iceGame.bets) {
        const zoneEnd = cumulative + bet.amount / iceGame.totalBank;
        if (relativeX <= zoneEnd) { winner = bet; break; }
        cumulative = zoneEnd;
    }
    
    const user = users.get(winner.userId);
    if (user) {
        user.balance += iceGame.totalBank;
        user.stats.wins++;
        user.stats.won += iceGame.totalBank;
        addHistory(user, 'Выигрыш (Ice Arena)', iceGame.totalBank, 'win');
        onlineUsers.forEach((uid, socketId) => {
            if (uid === winner.userId) {
                io.to(socketId).emit('balance:update', user.balance);
                io.to(socketId).emit('stats:update', user.stats);
                io.to(socketId).emit('history:update', user.history);
            }
        });
    }
    
    iceGame.winnerData = { winnerName: winner.name, winnerAmount: iceGame.totalBank };
    io.emit('ice:result', iceGame.winnerData);
    io.emit('ice:state', getIcePublicState());
    
    setTimeout(() => startIceTimer(), 2200);
}

startRollTimer();
startCrashTimer();
startIceTimer();

server.listen(PORT, () => {
    console.log(`🚀 KR Bet server running on port ${PORT}`);
    console.log(`🤖 Bot Token: ${BOT_TOKEN ? 'Configured' : 'NOT CONFIGURED'}`);
});
