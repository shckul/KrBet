// ============================================
// KR Bet — Telegram Mini App Server
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
const CHANNEL_USERNAME = 'Kr_Bet_Up';

const users = new Map();
const pendingPayments = new Map();
const onlineUsers = new Map();
const presence = new Map();
const withdrawalRequests = [];
const withdrawalHistory = [];

const REFFERAL_PERCENT = 0.15;
const ADMIN_CODE = '22092011';

function getUserFromInitData(initData) {
    if (!initData) return null;
    try {
        const data = new URLSearchParams(initData);
        const userStr = data.get('user');
        if (!userStr) return null;
        const user = JSON.parse(userStr);
        return {
            id: user.id,
            username: user.username || '',
            firstName: user.first_name || 'Player',
            lastName: user.last_name || '',
            photoUrl: user.photo_url || ''
        };
    } catch (e) { return null; }
}

function verifyInitData(initData) {
    if (!BOT_TOKEN || !initData) return true;
    try {
        const data = new URLSearchParams(initData);
        const hash = data.get('hash');
        if (!hash) return true;
        data.delete('hash');
        const arr = [];
        for (const [k, v] of data.entries()) arr.push(`${k}=${v}`);
        arr.sort();
        const dataCheckString = arr.join('\n');
        const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
        return hmac === hash;
    } catch (e) { return true; }
}

function getStartParam(initData) {
    if (!initData) return null;
    try {
        const data = new URLSearchParams(initData);
        return data.get('start_param');
    } catch (e) { return null; }
}

function getOrCreateUser(userData, startParam) {
    if (!users.has(userData.id)) {
        let referrerId = null;
        if (startParam && startParam.startsWith('ref_')) {
            const possibleRef = parseInt(startParam.slice(4), 10);
            if (!isNaN(possibleRef) && possibleRef !== userData.id) referrerId = possibleRef;
        }
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
            missions: {},
            totalDeposited: 0,
            maxCrashCashout: 0,
            rollWins: 0,
            iceWins: 0,
            roadWins: 0,
            lastFreeCaseAt: 0,
            referrerId: referrerId,
            referrals: [],
            totalBets: 0,
            totalWins: 0,
            casesOpened: 0,
            totalReferralEarned: 0
        });
        if (referrerId && users.has(referrerId)) {
            users.get(referrerId).referrals.push(userData.id);
        }
    } else {
        const user = users.get(userData.id);
        user.lastActive = Date.now();
        if (userData.photoUrl) user.photoUrl = userData.photoUrl;
        if (userData.username) user.username = userData.username;
        if (userData.firstName) user.firstName = userData.firstName;
    }
    return users.get(userData.id);
}

function addHistory(user, action, amount, type) {
    user.history.unshift({ action, amount, type, time: Date.now() });
    if (user.history.length > 50) user.history.pop();
    onlineUsers.forEach((uid, socketId) => {
        if (uid === user.id) io.to(socketId).emit('history:update', user.history);
    });
}

function emitBalance(user) {
    onlineUsers.forEach((uid, socketId) => {
        if (uid === user.id) io.to(socketId).emit('balance:update', user.balance);
    });
}

function emitStats(user) {
    onlineUsers.forEach((uid, socketId) => {
        if (uid === user.id) io.to(socketId).emit('stats:update', user.stats);
    });
}

function pushLiveWin(game, name, amount) {
    io.emit('live:win', { game, name, amount, time: Date.now() });
}

function giveReferralCut(user, betAmount) {
    if (!user.referrerId) return;
    const ref = users.get(user.referrerId);
    if (!ref) return;
    const cut = Math.floor(betAmount * REFFERAL_PERCENT);
    if (cut <= 0) return;
    ref.balance += cut;
    ref.totalReferralEarned = (ref.totalReferralEarned || 0) + cut;
    addHistory(ref, 'Реферальный бонус от ' + (user.firstName || 'друга'), cut, 'win');
    emitBalance(ref);
}

function takeBet(user, amount, historyAction) {
    if (amount < 10) return false;
    if (user.balance < amount) return false;
    user.balance -= amount;
    user.stats.spent += amount;
    user.totalBets = (user.totalBets || 0) + amount;
    addHistory(user, historyAction, amount, 'bet');
    emitBalance(user);
    emitStats(user);
    giveReferralCut(user, amount);
    return true;
}

function payWin(user, amount, historyAction, extraStats) {
    user.balance += amount;
    user.stats.wins += 1;
    user.stats.won += amount;
    user.totalWins = (user.totalWins || 0) + 1;
    if (extraStats) Object.assign(user, extraStats);
    addHistory(user, historyAction, amount, 'win');
    emitBalance(user);
    emitStats(user);
}

app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/balance', (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData || !verifyInitData(initData)) return res.json({ balance: 0 });
    const userData = getUserFromInitData(initData);
    if (!userData) return res.json({ balance: 0 });
    const startParam = getStartParam(initData);
    const user = getOrCreateUser(userData, startParam);
    res.json({
        balance: user.balance,
        stats: user.stats,
        history: user.history,
        user: { id: user.id, name: user.firstName, photoUrl: user.photoUrl }
    });
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
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `Пополнение ${amount} ★`,
                description: `Пополнение баланса KR Bet на ${amount} звёзд`,
                payload: payload,
                currency: 'XTR',
                prices: [{ label: `${amount} звёзд`, amount: amount }]
            })
        });
        const invoiceData = await invoiceResponse.json();
        if (!invoiceData.ok) return res.status(500).json({ success: false, error: 'Ошибка создания платежа' });
        pendingPayments.set(paymentId, { userId: user.id, amount, status: 'pending' });
        res.json({ success: true, invoiceLink: invoiceData.result });
    } catch (e) { res.status(500).json({ success: false }); }
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
                        user.totalDeposited = (user.totalDeposited || 0) + amount;
                        addHistory(user, 'Пополнение баланса', amount, 'deposit');
                        emitBalance(user);
                    }
                }
            }
        }
        if (body.pre_checkout_query) {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pre_checkout_query_id: body.pre_checkout_query.id, ok: true })
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
    emitBalance(user);
    const request = {
        id: crypto.randomUUID(),
        userId: user.id,
        name: user.firstName || 'Player',
        username: user.username || '',
        amount,
        time: Date.now()
    };
    withdrawalRequests.push(request);
    res.json({ success: true, balance: user.balance });
});

app.post('/api/missions/check-subscription', async (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData) return res.status(401).json({ success: false });
    const userData = getUserFromInitData(initData);
    if (!userData) return res.status(401).json({ success: false });
    const user = getOrCreateUser(userData);
    try {
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${CHANNEL_USERNAME}&user_id=${user.id}`);
        const data = await response.json();
        if (!data.ok) return res.json({ success: false, subscribed: false, error: 'Ошибка проверки' });
        const status = data.result?.status;
        const subscribed = ['member', 'administrator', 'creator'].includes(status);
        if (!subscribed) return res.json({ success: true, subscribed: false });
        if (user.missions['subscribe']) {
            return res.json({ success: true, subscribed: true, alreadyClaimed: true });
        }
        user.missions['subscribe'] = true;
        user.balance += 10;
        addHistory(user, 'Миссия: Подписка на канал', 10, 'win');
        emitBalance(user);
        res.json({ success: true, subscribed: true, reward: 10, balance: user.balance });
    } catch (e) { res.json({ success: false, subscribed: false, error: 'Ошибка сервера' }); }
});

const FREE_CASE_COOLDOWN = 24 * 60 * 60 * 1000;
const FREE_CASE_DROPS = [1, 2, 3, 5];
const FREE_CASE_WEIGHTS = [30, 30, 25, 15];

function rollFreeCase() {
    const total = FREE_CASE_WEIGHTS.reduce((s, w) => s + w, 0);
    let random = Math.random() * total;
    for (let i = 0; i < FREE_CASE_WEIGHTS.length; i++) {
        random -= FREE_CASE_WEIGHTS[i];
        if (random <= 0) return FREE_CASE_DROPS[i];
    }
    return 1;
}

app.post('/api/free-case/open', async (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData) return res.status(401).json({ success: false });
    const userData = getUserFromInitData(initData);
    if (!userData) return res.status(401).json({ success: false });
    const user = getOrCreateUser(userData);

    const now = Date.now();
    const last = user.lastFreeCaseAt || 0;
    if (now - last < FREE_CASE_COOLDOWN) {
        const left = FREE_CASE_COOLDOWN - (now - last);
        return res.json({ success: false, cooldown: true, remaining: left });
    }

    try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${CHANNEL_USERNAME}&user_id=${user.id}`);
        const data = await r.json();
        if (!data.ok) return res.json({ success: false, subscribed: false, error: 'Ошибка проверки' });
        const status = data.result?.status;
        const subscribed = ['member', 'administrator', 'creator'].includes(status);
        if (!subscribed) return res.json({ success: false, subscribed: false });
    } catch (e) {
        return res.json({ success: false, subscribed: false, error: 'Ошибка сервера' });
    }

    const drop = rollFreeCase();
    user.balance += drop;
    user.lastFreeCaseAt = now;
    user.casesOpened = (user.casesOpened || 0) + 1;
    addHistory(user, 'Бесплатный кейс: +' + drop + ' ★', drop, 'win');
    emitBalance(user);
    res.json({
        success: true,
        drop,
        drops: FREE_CASE_DROPS,
        balance: user.balance
    });
});

app.get('/api/free-case/status', (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData) return res.status(401).json({ success: false });
    const userData = getUserFromInitData(initData);
    if (!userData) return res.status(401).json({ success: false });
    const user = getOrCreateUser(userData);
    const now = Date.now();
    const last = user.lastFreeCaseAt || 0;
    const remaining = Math.max(0, FREE_CASE_COOLDOWN - (now - last));
    res.json({ success: true, remaining, canOpen: remaining === 0 });
});

const MISSIONS = [
    { id: 'subscribe', title: 'Подписаться на канал @Kr_Bet_Up', reward: 10, type: 'subscription' },
    { id: 'crash_5x', title: 'Поймать 5x+ в Ракетке', reward: 20, type: 'counter', getProgress: u => Math.min(u.maxCrashCashout || 0, 5), target: 5, progressText: u => `Макс. кэшаут: ${(u.maxCrashCashout || 0).toFixed(2)}x / 5.00x` },
    { id: 'roll_10_wins', title: 'Выиграть в Рулетке 10 раз', reward: 30, type: 'counter', getProgress: u => Math.min(u.rollWins || 0, 10), target: 10, progressText: u => `Побед: ${u.rollWins || 0} / 10` },
    { id: 'ice_10_wins', title: 'Выиграть в Ice Arena 10 раз', reward: 30, type: 'counter', getProgress: u => Math.min(u.iceWins || 0, 10), target: 10, progressText: u => `Побед: ${u.iceWins || 0} / 10` },
    { id: 'deposit_300', title: 'Пополнить баланс на 300 ★', reward: 30, type: 'counter', getProgress: u => Math.min(u.totalDeposited || 0, 300), target: 300, progressText: u => `Пополнено: ${u.totalDeposited || 0} / 300 ★` },
    { id: 'bet_500', title: 'Сделать ставок на 500 ★', reward: 25, type: 'counter', getProgress: u => Math.min(u.totalBets || 0, 500), target: 500, progressText: u => `Потрачено: ${u.totalBets || 0} / 500 ★` },
    { id: 'bet_2000', title: 'Сделать ставок на 2000 ★', reward: 60, type: 'counter', getProgress: u => Math.min(u.totalBets || 0, 2000), target: 2000, progressText: u => `Потрачено: ${u.totalBets || 0} / 2000 ★` },
    { id: 'case_open', title: 'Открыть 10 кейсов', reward: 40, type: 'counter', getProgress: u => Math.min(u.casesOpened || 0, 10), target: 10, progressText: u => `Открыто: ${u.casesOpened || 0} / 10` }
];

app.get('/api/missions', (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData) return res.status(401).json({ success: false });
    const userData = getUserFromInitData(initData);
    if (!userData) return res.status(401).json({ success: false });
    const user = getOrCreateUser(userData);
    const missions = MISSIONS.map(m => {
        const claimed = !!user.missions[m.id];
        let progress = 0, target = 1, progressText = '', completed = false;
        if (m.type === 'counter') {
            progress = m.getProgress(user); target = m.target; progressText = m.progressText(user); completed = progress >= target;
        } else if (m.type === 'subscription') {
            completed = claimed; progress = claimed ? 1 : 0; target = 1; progressText = claimed ? 'Подписка активна' : '';
        }
        return { id: m.id, title: m.title, reward: m.reward, type: m.type, claimed, completed, progress, target, progressText };
    });
    res.json({ success: true, missions });
});

app.post('/api/missions/claim', (req, res) => {
    const initData = req.headers['x-telegram-init-data'];
    const { missionId } = req.body;
    if (!initData || !missionId) return res.status(400).json({ success: false });
    const userData = getUserFromInitData(initData);
    if (!userData) return res.status(401).json({ success: false });
    const user = getOrCreateUser(userData);
    if (user.missions[missionId]) return res.status(400).json({ success: false, error: 'Уже получено' });
    const mission = MISSIONS.find(m => m.id === missionId);
    if (!mission) return res.status(404).json({ success: false, error: 'Миссия не найдена' });
    if (mission.type === 'counter') {
        const progress = mission.getProgress(user);
        if (progress < mission.target) return res.status(400).json({ success: false, error: 'Не выполнено' });
    } else if (mission.type === 'subscription') {
        return res.status(400).json({ success: false, error: 'Используйте check-subscription' });
    }
    user.missions[missionId] = true;
    user.balance += mission.reward;
    addHistory(user, 'Миссия: ' + mission.title, mission.reward, 'win');
    emitBalance(user);
    res.json({ success: true, balance: user.balance, reward: mission.reward });
});

function adminAuth(req, res) {
    const initData = req.headers['x-telegram-init-data'];
    const adminCode = req.headers['x-admin-code'];
    if (!initData || adminCode !== ADMIN_CODE) { res.status(401).json({ success: false }); return null; }
    return getUserFromInitData(initData);
}

app.get('/api/admin/players', (req, res) => {
    if (!adminAuth(req, res)) return;
    const players = [];
    users.forEach(u => {
        players.push({
            userId: u.id, name: u.firstName || 'Player', username: u.username, balance: u.balance,
            online: [...onlineUsers.values()].includes(u.id)
        });
    });
    players.sort((a, b) => b.balance - a.balance);
    res.json({ success: true, players });
});

app.post('/api/admin/set-balance', (req, res) => {
    if (!adminAuth(req, res)) return;
    const { userId, action, amount } = req.body;
    const numericUserId = parseInt(userId);
    const user = users.get(numericUserId);
    if (!user) return res.status(404).json({ success: false });
    const n = parseInt(amount);
    if (isNaN(n) || n <= 0) return res.status(400).json({ success: false });
    if (action === 'add') user.balance += n;
    else if (action === 'sub') user.balance = Math.max(0, user.balance - n);
    addHistory(user, action === 'add' ? 'Начисление админом' : 'Списание админом', n, action === 'add' ? 'win' : 'bet');
    emitBalance(user);
    res.json({ success: true, balance: user.balance });
});

app.get('/api/admin/withdrawals', (req, res) => {
    if (!adminAuth(req, res)) return;
    res.json({ success: true, requests: withdrawalRequests });
});
app.get('/api/admin/withdrawals-history', (req, res) => {
    if (!adminAuth(req, res)) return;
    res.json({ success: true, history: withdrawalHistory });
});
app.post('/api/admin/withdrawal-action', (req, res) => {
    if (!adminAuth(req, res)) return;
    const { id, action } = req.body;
    if (!id || !action) return res.status(400).json({ success: false });
    const index = withdrawalRequests.findIndex(r => r.id === id);
    if (index === -1) return res.status(404).json({ success: false });
    const request = withdrawalRequests[index];
    withdrawalRequests.splice(index, 1);
    if (action === 'reject') {
        const user = users.get(request.userId);
        if (user) {
            user.balance += request.amount;
            addHistory(user, 'Возврат вывода', request.amount, 'win');
            emitBalance(user);
        }
    }
    withdrawalHistory.unshift({ ...request, status: action === 'approve' ? 'approved' : 'rejected', processedAt: Date.now() });
    res.json({ success: true });
});

const rollGame = {
    phase: 'waiting', bets: [], timerSeconds: 15, timerInterval: null,
    winnerIndex: -1, forcedWinner: null, winnerData: null,
    spinAngle: 0, spinDuration: 0, finalAngle: 0
};

function getRollPublicState() {
    return {
        phase: rollGame.phase,
        timerSeconds: rollGame.timerSeconds,
        bets: rollGame.bets.map(b => ({ userId: b.userId, name: b.name, amount: b.amount, color: b.color })),
        totalBank: rollGame.bets.reduce((s, b) => s + b.amount, 0),
        winnerIndex: rollGame.winnerIndex,
        spinAngle: rollGame.spinAngle,
        spinDuration: rollGame.spinDuration,
        finalAngle: rollGame.finalAngle
    };
}

function startRollTimer() {
    if (rollGame.bets.length === 1) {
        const bet = rollGame.bets[0];
        const user = users.get(bet.userId);
        if (user) {
            user.balance += bet.amount;
            addHistory(user, 'Возврат (Рулетка — 1 игрок)', bet.amount, 'win');
            emitBalance(user);
        }
    }
    rollGame.phase = 'waiting';
    rollGame.timerSeconds = 15;
    rollGame.bets = [];
    rollGame.winnerIndex = -1;
    rollGame.forcedWinner = null;
    rollGame.spinAngle = 0;
    rollGame.spinDuration = 0;
    rollGame.finalAngle = 0;
    io.emit('roll:state', getRollPublicState());

    if (rollGame.timerInterval) clearInterval(rollGame.timerInterval);
    rollGame.timerInterval = setInterval(() => {
        rollGame.timerSeconds--;
        io.emit('roll:timer', rollGame.timerSeconds);
        if (rollGame.timerSeconds <= 0) {
            clearInterval(rollGame.timerInterval);
            startRollSpin();
        }
    }, 1000);
}

function startRollSpin() {
    if (rollGame.bets.length === 0) { setTimeout(startRollTimer, 600); return; }
    if (rollGame.bets.length === 1) {
        const bet = rollGame.bets[0];
        const user = users.get(bet.userId);
        if (user) {
            user.balance += bet.amount;
            addHistory(user, 'Возврат (Рулетка — 1 игрок)', bet.amount, 'win');
            emitBalance(user);
        }
        rollGame.bets = [];
        setTimeout(startRollTimer, 1500);
        return;
    }
    rollGame.phase = 'spinning';
    const totalBank = rollGame.bets.reduce((s, b) => s + b.amount, 0);
    let finalAngleDeg, winnerIndex;

    if (rollGame.forcedWinner) {
        winnerIndex = rollGame.bets.findIndex(b => b.userId === rollGame.forcedWinner);
        if (winnerIndex === -1) winnerIndex = 0;
        let cumulative = 0;
        for (let i = 0; i < winnerIndex; i++) cumulative += (rollGame.bets[i].amount / totalBank) * 360;
        const sweep = (rollGame.bets[winnerIndex].amount / totalBank) * 360;
        finalAngleDeg = cumulative + Math.random() * sweep;
    } else {
        finalAngleDeg = Math.random() * 360;
        let cumulative = 0;
        winnerIndex = 0;
        for (let i = 0; i < rollGame.bets.length; i++) {
            const sweep = (rollGame.bets[i].amount / totalBank) * 360;
            if (finalAngleDeg >= cumulative && finalAngleDeg < cumulative + sweep) { winnerIndex = i; break; }
            cumulative += sweep;
        }
    }

    rollGame.winnerIndex = winnerIndex;
    rollGame.finalAngle = finalAngleDeg;
    const winner = rollGame.bets[winnerIndex];
    const spins = 5 + Math.floor(Math.random() * 6);
    const duration = 3800 + Math.random() * 800;
    rollGame.spinAngle = spins * 360 + finalAngleDeg;
    rollGame.spinDuration = duration;
    io.emit('roll:state', getRollPublicState());

    setTimeout(() => {
        rollGame.phase = 'result';
        const user = users.get(winner.userId);
        if (user) {
            user.balance += totalBank;
            user.stats.wins += 1;
            user.stats.won += totalBank;
            user.rollWins = (user.rollWins || 0) + 1;
            user.totalWins = (user.totalWins || 0) + 1;
            addHistory(user, 'Выигрыш (Рулетка)', totalBank, 'win');
            emitBalance(user);
            emitStats(user);
        }
        rollGame.winnerData = { winnerName: winner.name, winnerAmount: totalBank, winnerIndex };
        io.emit('roll:result', rollGame.winnerData);
        io.emit('roll:state', getRollPublicState());
        pushLiveWin('Рулетка', winner.name, totalBank);
        setTimeout(startRollTimer, 2200);
    }, duration);
}

const crashGame = {
    phase: 'waiting', multiplier: 1.00, maxMultiplier: 1.00, countdown: 5, bets: [],
    history: [], forcedMultiplier: null, forceCrashNow: false,
    crashInterval: null, countdownInterval: null, startedAt: 0
};

function getCrashPublicState() {
    return {
        phase: crashGame.phase,
        multiplier: crashGame.multiplier,
        countdown: crashGame.countdown,
        bets: crashGame.bets.map(b => ({ userId: b.userId, name: b.name, amount: b.amount, cashedOut: b.cashedOut, cashoutMultiplier: b.cashoutMultiplier })),
        history: crashGame.history,
        startedAt: crashGame.startedAt
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
        crashGame.countdown = countdown;
        io.emit('crash:countdown', countdown);
        if (countdown <= 0) {
            clearInterval(crashGame.countdownInterval);
            startCrashFlight();
        }
    }, 1000);
}

function startCrashFlight() {
    crashGame.phase = 'flying';
    crashGame.multiplier = 1.00;
    if (crashGame.forcedMultiplier) crashGame.maxMultiplier = crashGame.forcedMultiplier;
    else {
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
    crashGame.history.unshift(crashGame.multiplier);
    if (crashGame.history.length > 15) crashGame.history.pop();
    io.emit('crash:crash', crashGame.multiplier);
    io.emit('crash:state', getCrashPublicState());
    setTimeout(() => startCrashTimer(), 5000);
}

const iceGame = {
    phase: 'waiting', timerSeconds: 15, bets: [], totalBank: 0,
    timerInterval: null, puckX: 170, puckY: 170,
    puckVX: 0, puckVY: 0, puckAnimation: null,
    winnerData: null, zones: []
};

const COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63','#00bcd4','#ff5722','#8bc34a','#3f51b5','#ff9800','#795548','#607d8b'];
const SLICE_ANGLES = [30, 60, 90, 120, 135, 45, 75, 105];

function getIcePublicState() {
    return {
        phase: iceGame.phase, timerSeconds: iceGame.timerSeconds,
        bets: iceGame.bets.map(b => ({ userId: b.userId, name: b.name, amount: b.amount, color: b.color })),
        totalBank: iceGame.totalBank,
        puckX: iceGame.puckX, puckY: iceGame.puckY,
        zones: iceGame.zones || []
    };
}

function startIceTimer() {
    if (iceGame.bets.length === 1) {
        const bet = iceGame.bets[0];
        const user = users.get(bet.userId);
        if (user) {
            user.balance += bet.amount;
            addHistory(user, 'Возврат (Ice Arena — 1 игрок)', bet.amount, 'win');
            emitBalance(user);
        }
    }
    iceGame.phase = 'waiting';
    iceGame.timerSeconds = 15;
    iceGame.bets = [];
    iceGame.totalBank = 0;
    iceGame.winnerData = null;
    iceGame.puckX = 170; iceGame.puckY = 170;
    iceGame.puckVX = 0; iceGame.puckVY = 0;
    iceGame.zones = [];
    io.emit('ice:state', getIcePublicState());

    if (iceGame.timerInterval) clearInterval(iceGame.timerInterval);
    iceGame.timerInterval = setInterval(() => {
        iceGame.timerSeconds--;
        io.emit('ice:timer', iceGame.timerSeconds);
        if (iceGame.timerSeconds <= 0) {
            clearInterval(iceGame.timerInterval);
            startIceLaunch();
        }
    }, 1000);
}

function generateIceZonesFixedAngles() {
    const bets = iceGame.bets;
    if (bets.length === 0) return [];
    if (bets.length === 1) {
        const b = bets[0];
        return [{ userId: b.userId, name: b.name, color: b.color, amount: b.amount, points: [{x:0,y:0},{x:340,y:0},{x:340,y:340},{x:0,y:340}], chance: 100 }];
    }
    const sorted = [...bets].sort((a, b) => b.amount - a.amount);
    const zones = [];
    let points = [{x:0,y:0},{x:340,y:0},{x:340,y:340},{x:0,y:340}];
    let remainingAmount = iceGame.totalBank;
    const lastBet = sorted[sorted.length - 1];
    const otherBets = sorted.slice(0, -1);
    for (let i = 0; i < otherBets.length; i++) {
        const bet = otherBets[i];
        const ratio = bet.amount / remainingAmount;
        remainingAmount -= bet.amount;
        const angleDeg = SLICE_ANGLES[i % SLICE_ANGLES.length];
        const angleRad = angleDeg * Math.PI / 180;
        const split = splitPolygonByAngle(points, ratio, angleRad);
        zones.push({ userId: bet.userId, name: bet.name, color: bet.color, amount: bet.amount, points: split.part1, chance: (bet.amount / iceGame.totalBank) * 100 });
        points = split.part2;
    }
    zones.push({ userId: lastBet.userId, name: lastBet.name, color: lastBet.color, amount: lastBet.amount, points: points, chance: (lastBet.amount / iceGame.totalBank) * 100 });
    return zones;
}

function splitPolygonByAngle(poly, ratio, angleRad) {
    const nx = -Math.sin(angleRad), ny = Math.cos(angleRad);
    let minProj = Infinity, maxProj = -Infinity;
    poly.forEach(p => { const v = p.x * nx + p.y * ny; if (v < minProj) minProj = v; if (v > maxProj) maxProj = v; });
    const totalArea = polygonArea(poly), targetArea = ratio * totalArea;
    let lo = minProj, hi = maxProj;
    for (let iter = 0; iter < 60; iter++) {
        const mid = (lo + hi) / 2;
        const part = clipPolygonByN(poly, nx, ny, mid, true);
        if (polygonArea(part) > targetArea) lo = mid; else hi = mid;
    }
    const finalProj = (lo + hi) / 2;
    return { part1: clipPolygonByN(poly, nx, ny, finalProj, true), part2: clipPolygonByN(poly, nx, ny, finalProj, false) };
}
function clipPolygonByN(poly, nx, ny, offset, keepPositive) {
    const result = [];
    const inside = (p) => { const v = p.x * nx + p.y * ny - offset; return keepPositive ? v >= 0 : v <= 0; };
    for (let i = 0; i < poly.length; i++) {
        const curr = poly[i], next = poly[(i + 1) % poly.length];
        const currIn = inside(curr), nextIn = inside(next);
        if (currIn) { const last = result[result.length - 1]; if (!last || Math.abs(last.x - curr.x) > 0.5 || Math.abs(last.y - curr.y) > 0.5) result.push({x:curr.x, y:curr.y}); }
        if (currIn !== nextIn) {
            const v1 = curr.x * nx + curr.y * ny - offset, v2 = next.x * nx + next.y * ny - offset;
            if (Math.abs(v1 - v2) < 0.001) continue;
            const t = v1 / (v1 - v2);
            result.push({x: curr.x + t * (next.x - curr.x), y: curr.y + t * (next.y - curr.y)});
        }
    }
    return result;
}
function polygonArea(poly) { if (poly.length < 3) return 0; let a = 0; for (let i = 0; i < poly.length; i++) { const j = (i + 1) % poly.length; a += poly[i].x * poly[j].y - poly[j].x * poly[i].y; } return Math.abs(a) / 2; }
function pointInPolygon(x, y, points) { if (!points || points.length < 3) return false; let inside = false; for (let i = 0, j = points.length - 1; i < points.length; j = i++) { const xi = points[i].x, yi = points[i].y, xj = points[j].x, yj = points[j].y; const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi); if (intersect) inside = !inside; } return inside; }

function startIceLaunch() {
    if (iceGame.bets.length === 0) { setTimeout(startIceTimer, 600); return; }
    if (iceGame.bets.length === 1) {
        const bet = iceGame.bets[0];
        const user = users.get(bet.userId);
        if (user) {
            user.balance += bet.amount;
            addHistory(user, 'Возврат (Ice Arena — 1 игрок)', bet.amount, 'win');
            emitBalance(user);
        }
        iceGame.bets = [];
        iceGame.totalBank = 0;
        iceGame.zones = [];
        setTimeout(startIceTimer, 1500);
        return;
    }
    iceGame.phase = 'launching';
    iceGame.zones = generateIceZonesFixedAngles();
    const margin = 340 * 0.25;
    iceGame.puckX = margin + Math.random() * (340 - margin * 2);
    iceGame.puckY = margin + Math.random() * (340 - margin * 2);
    io.emit('ice:state', getIcePublicState());
    io.emit('ice:zones', iceGame.zones);
    setTimeout(() => {
        const finalAngle = Math.random() * 360;
        setTimeout(() => launchIcePuck(finalAngle), 200);
    }, 1000);
}

function launchIcePuck(angle) {
    iceGame.phase = 'sliding';
    const speed = 14;
    const rad = angle * Math.PI / 180;
    iceGame.puckVX = Math.cos(rad) * speed;
    iceGame.puckVY = Math.sin(rad) * speed;
    const MIN = 10, MAX = 330;
    if (iceGame.puckAnimation) clearInterval(iceGame.puckAnimation);
    iceGame.puckAnimation = setInterval(() => {
        iceGame.puckX += iceGame.puckVX;
        iceGame.puckY += iceGame.puckVY;
        if (iceGame.puckX < MIN) { iceGame.puckX = MIN; iceGame.puckVX = Math.abs(iceGame.puckVX) * 0.85; }
        else if (iceGame.puckX > MAX) { iceGame.puckX = MAX; iceGame.puckVX = -Math.abs(iceGame.puckVX) * 0.85; }
        if (iceGame.puckY < MIN) { iceGame.puckY = MIN; iceGame.puckVY = Math.abs(iceGame.puckVY) * 0.85; }
        else if (iceGame.puckY > MAX) { iceGame.puckY = MAX; iceGame.puckVY = -Math.abs(iceGame.puckVY) * 0.85; }
        const sp = Math.sqrt(iceGame.puckVX * iceGame.puckVX + iceGame.puckVY * iceGame.puckVY);
        if (sp > 8) { iceGame.puckVX *= 0.999; iceGame.puckVY *= 0.999; }
        else if (sp > 4) { iceGame.puckVX *= 0.997; iceGame.puckVY *= 0.997; }
        else if (sp > 2) { iceGame.puckVX *= 0.995; iceGame.puckVY *= 0.995; }
        else { iceGame.puckVX *= 0.97; iceGame.puckVY *= 0.97; }
        io.emit('ice:puck', { x: iceGame.puckX, y: iceGame.puckY });
        if (Math.abs(iceGame.puckVX) < 0.02 && Math.abs(iceGame.puckVY) < 0.02) {
            clearInterval(iceGame.puckAnimation);
            finishIceRound();
        }
    }, 16);
}

function finishIceRound() {
    iceGame.phase = 'result';
    let winner = iceGame.bets[0];
    for (const zone of iceGame.zones) {
        if (pointInPolygon(iceGame.puckX, iceGame.puckY, zone.points)) {
            const bet = iceGame.bets.find(b => b.userId === zone.userId);
            if (bet) winner = bet;
            break;
        }
    }
    const user = users.get(winner.userId);
    if (user) {
        user.balance += iceGame.totalBank;
        user.stats.wins += 1;
        user.stats.won += iceGame.totalBank;
        user.iceWins = (user.iceWins || 0) + 1;
        user.totalWins = (user.totalWins || 0) + 1;
        addHistory(user, 'Выигрыш (Ice Arena)', iceGame.totalBank, 'win');
        emitBalance(user);
        emitStats(user);
    }
    iceGame.winnerData = { winnerName: winner.name, winnerAmount: iceGame.totalBank };
    io.emit('ice:result', iceGame.winnerData);
    io.emit('ice:state', getIcePublicState());
    pushLiveWin('Айс Арена', winner.name, iceGame.totalBank);
    setTimeout(startIceTimer, 2200);
}

io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('auth', (initData) => {
        if (!verifyInitData(initData)) return;
        const userData = getUserFromInitData(initData);
        if (userData) {
            const startParam = getStartParam(initData);
            currentUser = getOrCreateUser(userData, startParam);
            onlineUsers.set(socket.id, currentUser.id);
            socket.emit('auth:success', {
                balance: currentUser.balance,
                stats: currentUser.stats,
                history: currentUser.history,
                user: { id: currentUser.id, name: currentUser.firstName, photoUrl: currentUser.photoUrl },
                referrerId: currentUser.referrerId || null,
                referralCount: (currentUser.referrals || []).length
            });
            socket.emit('roll:state', getRollPublicState());
            socket.emit('roll:timer', rollGame.timerSeconds);
            socket.emit('crash:state', getCrashPublicState());
            socket.emit('crash:tick', crashGame.multiplier);
            socket.emit('ice:state', getIcePublicState());
            socket.emit('ice:timer', iceGame.timerSeconds);
        }
    });

    socket.on('presence:join', ({ tab }) => {
        if (!tab) return;
        presence.forEach((set, key) => { if (key !== tab) set.delete(socket.id); });
        if (!presence.has(tab)) presence.set(tab, new Set());
        presence.get(tab).add(socket.id);
    });
    socket.on('presence:leave', ({ tab }) => {
        if (presence.has(tab)) presence.get(tab).delete(socket.id);
    });

    socket.on('roll:bet', (data) => {
        if (!currentUser) return;
        const amount = parseInt(data.amount);
        if (isNaN(amount) || amount < 10) return;
        if (rollGame.phase !== 'waiting') return;
        if (rollGame.bets.some(b => b.userId === currentUser.id)) return;
        if (!takeBet(currentUser, amount, 'Игровая ставка (Рулетка)')) return;
        const usedColors = rollGame.bets.map(b => b.color);
        const avail = COLORS.filter(c => !usedColors.includes(c));
        const color = avail.length ? avail[Math.floor(Math.random() * avail.length)] : '#c9a84c';
        rollGame.bets.push({ userId: currentUser.id, name: currentUser.firstName || 'Player', amount, color });
        io.emit('roll:state', getRollPublicState());
    });

    socket.on('crash:bet', (data) => {
        if (!currentUser) return;
        const amount = parseInt(data.amount);
        if (isNaN(amount) || amount < 10) return;
        if (crashGame.phase !== 'waiting') return;
        if (crashGame.bets.some(b => b.userId === currentUser.id)) return;
        if (!takeBet(currentUser, amount, 'Игровая ставка (Crash)')) return;
        crashGame.bets.push({ userId: currentUser.id, name: currentUser.firstName || 'Player', amount, cashedOut: false, cashoutMultiplier: 0 });
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
        currentUser.stats.wins += 1;
        currentUser.stats.won += win;
        currentUser.totalWins = (currentUser.totalWins || 0) + 1;
        if (crashGame.multiplier > (currentUser.maxCrashCashout || 0)) currentUser.maxCrashCashout = crashGame.multiplier;
        addHistory(currentUser, 'Выигрыш (Crash)', win, 'win');
        emitBalance(currentUser);
        emitStats(currentUser);
        socket.emit('crash:cashedOut', { win, multiplier: crashGame.multiplier });
        io.emit('crash:state', getCrashPublicState());
        pushLiveWin('Ракетка', currentUser.firstName || 'Player', win);
    });

    socket.on('ice:bet', (data) => {
        if (!currentUser) return;
        const amount = parseInt(data.amount);
        if (isNaN(amount) || amount < 10) return;
        if (iceGame.phase !== 'waiting') return;
        if (iceGame.bets.some(b => b.userId === currentUser.id)) return;
        if (!takeBet(currentUser, amount, 'Ставка (Ice Arena)')) return;
        const usedColors = iceGame.bets.map(b => b.color);
        const avail = COLORS.filter(c => !usedColors.includes(c));
        const color = avail.length ? avail[Math.floor(Math.random() * avail.length)] : '#c9a84c';
        iceGame.bets.push({ userId: currentUser.id, name: currentUser.firstName || 'Player', amount, color });
        iceGame.totalBank += amount;
        iceGame.zones = generateIceZonesFixedAngles();
        io.emit('ice:state', getIcePublicState());
        io.emit('ice:zones', iceGame.zones);
    });

    const CASES_PRICES = { trash: 10, farmer: 30, funny: 67, okup: 150, star: 500 };
    const CASES_DROPS = {
        trash: { drops: [1,2,3,5,10,20,35,50,100], weights: [5,10,25,25,15,10,5,3,1] },
        farmer: { drops: [1,5,10,20,30,35,40,50,65,80,100,150,200], weights: [3,5,10,18,22,20,10,5,3,2,1,0.5,0.2] },
        funny: { drops: [1,5,10,67,150,300], weights: [5,10,45,20,12,3] },
        okup: { drops: [35,50,80,120,180,250,450], weights: [10,25,30,15,10,5,1] },
        star: { drops: [1,150,250,300,450,650,750,850,1000], weights: [2,20,20,18,15,10,8,5,2] }
    };
    function rollCase(caseId) {
        const cfg = CASES_DROPS[caseId];
        if (!cfg) return 0;
        const total = cfg.weights.reduce((s, w) => s + w, 0);
        let random = Math.random() * total;
        for (let i = 0; i < cfg.weights.length; i++) {
            random -= cfg.weights[i];
            if (random <= 0) return cfg.drops[i];
        }
        return cfg.drops[0];
    }
    socket.on('case:open', (data) => {
        if (!currentUser) return;
        const caseId = data.caseId;
        const price = CASES_PRICES[caseId];
        if (!price) return;
        if (currentUser.balance < price) return;

        currentUser.balance -= price;
        currentUser.stats.spent += price;
        currentUser.casesOpened = (currentUser.casesOpened || 0) + 1;
        currentUser.totalBets = (currentUser.totalBets || 0) + price;
        addHistory(currentUser, 'Кейс ' + caseId, price, 'bet');
        emitBalance(currentUser);
        emitStats(currentUser);
        giveReferralCut(currentUser, price);

        const drop = rollCase(caseId);

        socket.emit('case:spin', { caseId, drop });

        const uid = currentUser.id;
        setTimeout(() => {
            const user = users.get(uid);
            if (!user) return;
            user.balance += drop;
            user.stats.wins += 1;
            user.stats.won += drop;
            user.totalWins = (user.totalWins || 0) + 1;
            addHistory(user, 'Выигрыш в кейсе ' + caseId, drop, 'win');
            emitBalance(user);
            emitStats(user);
            onlineUsers.forEach((uId, socketId) => {
                if (uId === uid) io.to(socketId).emit('case:result', { caseId, drop });
            });
            if (drop >= price * 2) pushLiveWin('Кейсы', user.firstName || 'Player', drop);
        }, 5100);
    });

    socket.on('upgrader:play', (data) => {
        if (!currentUser) return;
        const bet = parseInt(data.bet);
        const target = parseInt(data.target);
        if (isNaN(bet) || isNaN(target) || bet < 10 || target <= bet) return;
        if (bet / target > 0.75) return;
        if (!takeBet(currentUser, bet, 'Ставка (Upgrader)')) return;
        const chance = bet / target;
        const won = Math.random() < chance;
        if (won) {
            payWin(currentUser, target, 'Выигрыш (Upgrader)');
            pushLiveWin('Апгрейд', currentUser.firstName || 'Player', target);
        }
        socket.emit('upgrader:result', { won, bet, target, chance });
    });

    const minesSessions = new Map();
    socket.on('mines:start', (data) => {
        if (!currentUser) return;
        const bet = parseInt(data.bet);
        const mines = parseInt(data.mines);
        if (isNaN(bet) || isNaN(mines) || bet < 10 || mines < 1 || mines > 24) return;
        if (minesSessions.has(currentUser.id)) return;
        if (!takeBet(currentUser, bet, 'Ставка (Mines)')) return;
        const bombs = new Set();
        while (bombs.size < mines) bombs.add(Math.floor(Math.random() * 25));
        minesSessions.set(currentUser.id, { bet, mines, bombs, revealed: new Set() });
        socket.emit('mines:started', { bet, mines });
    });
    socket.on('mines:open', (data) => {
        if (!currentUser) return;
        const s = minesSessions.get(currentUser.id);
        if (!s) return;
        const idx = parseInt(data.index);
        if (isNaN(idx) || idx < 0 || idx > 24 || s.revealed.has(idx)) return;
        if (s.bombs.has(idx)) {
            minesSessions.delete(currentUser.id);
            socket.emit('mines:boom', { index: idx, bombs: [...s.bombs] });
            return;
        }
        s.revealed.add(idx);
        const total = 25;
        let mult = 1;
        for (let i = 0; i < s.revealed.size; i++) mult *= (total - s.mines - i) / (total - i);
        mult = 1 / mult;
        if (s.revealed.size === total - s.mines) {
            const win = Math.floor(s.bet * mult);
            payWin(currentUser, win, 'Выигрыш (Mines)');
            minesSessions.delete(currentUser.id);
            socket.emit('mines:cashout', { win, mult, bombs: [...s.bombs] });
            pushLiveWin('Мины', currentUser.firstName || 'Player', win);
            return;
        }
        socket.emit('mines:opened', { index: idx, mult: parseFloat(mult.toFixed(2)) });
    });
    socket.on('mines:cashout', () => {
        if (!currentUser) return;
        const s = minesSessions.get(currentUser.id);
        if (!s) return;
        const total = 25;
        let mult = 1;
        for (let i = 0; i < s.revealed.size; i++) mult *= (total - s.mines - i) / (total - i);
        mult = 1 / mult;
        const win = Math.floor(s.bet * mult);
        payWin(currentUser, win, 'Выигрыш (Mines)');
        minesSessions.delete(currentUser.id);
        socket.emit('mines:cashout', { win, mult, bombs: [...s.bombs] });
        if (win >= s.bet * 2) pushLiveWin('Мины', currentUser.firstName || 'Player', win);
    });

    const ROAD_DIFFS_SERVER = {
        easy: { survive: [0.85,0.84,0.83,0.82,0.81,0.80,0.79,0.78,0.77,0.76,0.75,0.74,0.73,0.72,0.71,0.70,0.69,0.68,0.67,0.66,0.65,0.64,0.63,0.62,0.61,0.60,0.59,0.58,0.57,0.56,0.55,0.54,0.53,0.52,0.51,0.50,0.49,0.48,0.47,0.46,0.45,0.44,0.43,0.42,0.41,0.40,0.39,0.38,0.37,0.35], multipliers: [1.2,1.4,1.6,1.9,2.2,2.5,2.9,3.3,3.8,4.3,5.0,5.7,6.5,7.5,8.6,9.9,11.4,13.1,15.1,17.4,20.0,23.1,26.6,30.7,35.4,40.8,47.0,54.2,62.5,72.0,83.0,95.7,110.3,127.2,146.6,169.0,194.8,224.6,258.9,298.4,344.0,396.6,457.2,527.0,607.5,700.4,807.4,930.7,1072.8,1236.6] },
        medium: { survive: [0.80,0.78,0.76,0.74,0.72,0.70,0.68,0.66,0.64,0.62,0.60,0.58,0.56,0.54,0.52,0.50,0.48,0.46,0.44,0.42,0.40,0.38,0.36,0.34,0.32,0.30,0.28,0.26,0.24,0.22,0.20,0.18,0.16,0.14,0.12,0.10,0.08,0.06,0.05,0.04,0.035,0.03,0.025,0.02,0.015,0.01,0.008,0.005,0.003,0.002], multipliers: [1.5,1.8,2.2,2.7,3.3,4.0,4.8,5.8,7.0,8.5,10.3,12.5,15.1,18.3,22.1,26.8,32.4,39.2,47.4,57.3,69.3,83.8,101.3,122.5,148.1,179.0,216.4,261.6,316.2,382.2,462.0,558.5,675.1,816.1,986.5,1192.4,1441.4,1742.3,2106.0,2545.4,3077.2,3719.8,4496.8,5435.6,6570.6,7941.9,9600.0,11603.9,14026.9,16954.8] },
        hard: { survive: [0.75,0.72,0.69,0.66,0.63,0.60,0.57,0.54,0.51,0.48,0.45,0.42,0.39,0.36,0.33,0.30,0.27,0.24,0.21,0.18,0.16,0.14,0.12,0.10,0.08,0.07,0.06,0.05,0.04,0.03,0.025,0.02,0.015,0.01,0.008,0.006,0.005,0.004,0.003,0.002,0.0015,0.001,0.0008,0.0005,0.0003,0.0002,0.0001,0.00008,0.00005,0.00001], multipliers: [1.8,2.2,2.8,3.5,4.4,5.6,7.0,8.9,11.3,14.3,18.1,22.9,29.0,36.7,46.5,58.8,74.4,94.2,119.2,150.8,190.9,241.5,305.6,386.7,489.3,619.2,783.5,991.4,1254.5,1587.4,2008.5,2540.9,3214.4,4066.5,5144.7,6508.8,8234.0,10417.4,13180.0,16675.6,21097.7,26692.8,33770.2,42727.9,54059.4,68394.4,86537.6,109487.2,138512.9,175247.4] },
        extreme: { survive: [0.70,0.66,0.62,0.58,0.54,0.50,0.46,0.42,0.38,0.34,0.30,0.26,0.22,0.18,0.15,0.12,0.10,0.08,0.06,0.05,0.04,0.03,0.025,0.02,0.015,0.01,0.008,0.006,0.004,0.003,0.002,0.0015,0.001,0.0008,0.0005,0.0003,0.0002,0.0001,0.00008,0.00005,0.00003,0.00002,0.00001,0.000008,0.000005,0.000003,0.000002,0.000001,0.0000005,0.0000001], multipliers: [2.0,2.6,3.4,4.5,5.9,7.8,10.3,13.6,17.9,23.6,31.2,41.1,54.2,71.4,94.1,124.0,163.4,215.3,283.8,374.0,492.9,649.6,856.2,1128.4,1487.1,1960.3,2583.3,3404.6,4487.2,5913.7,7795.6,10275.0,13542.9,17850.6,23527.5,31010.4,40874.1,53876.8,71015.5,93603.6,123377.8,162630.1,214352.6,282544.4,372421.8,490849.7,646978.0,852705.7,1123855.2,1481351.6] }
    };
    const roadSessions = new Map();
    socket.on('road:start', (data) => {
        if (!currentUser) return;
        const diff = data.diff;
        const bet = parseInt(data.bet);
        if (!ROAD_DIFFS_SERVER[diff] || isNaN(bet) || bet < 10) return;
        if (roadSessions.has(currentUser.id)) return;
        if (!takeBet(currentUser, bet, 'Ставка (Дорога иксов)')) return;
        const cfg = ROAD_DIFFS_SERVER[diff];
        const survived = Math.random() < cfg.survive[0];
        if (!survived) {
            socket.emit('road:result', { exploded: true, step: 0, bet });
            return;
        }
        roadSessions.set(currentUser.id, { diff, bet, step: 0 });
        socket.emit('road:started', { diff, bet, step: 0, mult: cfg.multipliers[0] });
    });
    socket.on('road:step', () => {
        if (!currentUser) return;
        const s = roadSessions.get(currentUser.id);
        if (!s) return;
        const cfg = ROAD_DIFFS_SERVER[s.diff];
        if (s.step >= 49) return;
        const survived = Math.random() < cfg.survive[s.step + 1];
        if (!survived) {
            roadSessions.delete(currentUser.id);
            socket.emit('road:result', { exploded: true, step: s.step, bet: s.bet });
            return;
        }
        s.step += 1;
        if (s.step === 49) {
            const win = Math.floor(s.bet * cfg.multipliers[49]);
            payWin(currentUser, win, 'Выигрыш (Дорога иксов)', { roadWins: (currentUser.roadWins || 0) + 1 });
            roadSessions.delete(currentUser.id);
            socket.emit('road:result', { exploded: false, step: 49, mult: cfg.multipliers[49], win });
            pushLiveWin('Дорога иксов', currentUser.firstName || 'Player', win);
            return;
        }
        socket.emit('road:step:ok', { step: s.step, mult: cfg.multipliers[s.step] });
    });
    socket.on('road:cashout', () => {
        if (!currentUser) return;
        const s = roadSessions.get(currentUser.id);
        if (!s) return;
        const cfg = ROAD_DIFFS_SERVER[s.diff];
        const mult = cfg.multipliers[s.step];
        const win = Math.floor(s.bet * mult);
        payWin(currentUser, win, 'Выигрыш (Дорога иксов)', { roadWins: (currentUser.roadWins || 0) + 1 });
        roadSessions.delete(currentUser.id);
        socket.emit('road:result', { exploded: false, step: s.step, mult, win });
        if (win >= s.bet * 2) pushLiveWin('Дорога иксов', currentUser.firstName || 'Player', win);
    });

    socket.on('admin:crash-now', () => {
        if (!currentUser) return;
        if (currentUser.id !== parseInt(process.env.ADMIN_ID || '0')) return;
        crashGame.forceCrashNow = true;
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.id);
        presence.forEach((set) => set.delete(socket.id));
        if (currentUser) {
            minesSessions.delete(currentUser.id);
            roadSessions.delete(currentUser.id);
        }
    });
});

setInterval(() => {
    const online = {
        menu: (presence.get('menu') || new Set()).size,
        roll: (presence.get('roll') || new Set()).size,
        crash: (presence.get('crash') || new Set()).size,
        mines: (presence.get('mines') || new Set()).size,
        ice: (presence.get('ice') || new Set()).size,
        road: (presence.get('road') || new Set()).size,
        upgrader: (presence.get('upgrader') || new Set()).size,
        cases: (presence.get('cases') || new Set()).size
    };
    io.emit('presence:update', online);
}, 2000);

startRollTimer();
startCrashTimer();
startIceTimer();

server.listen(PORT, () => {
    console.log(`🚀 KR Bet server running on port ${PORT}`);
    console.log(`🤖 Bot Token: ${BOT_TOKEN ? 'Configured' : 'NOT CONFIGURED'}`);
});
