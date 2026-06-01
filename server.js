const http = require("http");
const fs   = require("fs");
const path = require("path");

const PORT = 3000;

const SUITS     = ["♠","♥","♦","♣"];
const VALUES    = ["7","8","Q","K","10","A","9","J"];
const POINT_MAP = { J:3, 9:2, A:1, 10:1, K:0, Q:0, 8:0, 7:0 };
const RANK_MAP  = { J:8, 9:7, A:6, 10:5, K:4, Q:3, 8:2, 7:1 };
const SEAT_NAMES= ["South","West","North","East"];
const AI_TAKEOVER_MS   = 20 * 1000;
const ROOM_IDLE_CLEANUP= 2 * 60 * 60 * 1000; // 2 hours

// ════════════════════════════════════════════════════════
//  PERSISTENCE
// ════════════════════════════════════════════════════════
const DATA_DIR    = path.join(process.cwd(), "data");
const ROOMS_FILE  = path.join(DATA_DIR, "rooms.json");
const PLAYERS_FILE= path.join(DATA_DIR, "players.json");
const MATCHES_FILE= path.join(DATA_DIR, "matches.json");

// Ensure data directory exists
try {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log(`Created data directory: ${DATA_DIR}`);
    }
} catch(e) {
    console.error("FATAL: Cannot create data directory:", e.message);
}

// Atomic write: write to .tmp then rename
function saveJSON(filePath, data) {
    const tmp = filePath + ".tmp";
    try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, filePath);
    } catch(e) {
        console.error(`Failed to save ${filePath}:`, e.message);
    }
}

function loadJSON(filePath, fallback) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch(e) {
        console.error(`Failed to load ${filePath}:`, e.message);
    }
    return fallback;
}

// ── players.json: { clientId → { name, firstSeen, lastSeen, roomsPlayed, handsPlayed, wins } }
let playersDB = loadJSON(PLAYERS_FILE, {});

// ── matches.json: array of completed match records
let matchesDB = loadJSON(MATCHES_FILE, []);

function saveAll() {
    // Save rooms (strip runtime-only fields that can't be resumed meaningfully)
    const roomsSnap = {};
    for (const [id, room] of rooms.entries()) {
        roomsSnap[id] = serializeRoom(room);
    }
    saveJSON(ROOMS_FILE,  roomsSnap);
    saveJSON(PLAYERS_FILE, playersDB);
    saveJSON(MATCHES_FILE, matchesDB);
}

// Fields we don't persist (will be reset on resume)
const SKIP_ON_SAVE = new Set(["lastActivityPerSeat"]);

function serializeRoom(room) {
    const out = {};
    for (const [k,v] of Object.entries(room)) {
        if (!SKIP_ON_SAVE.has(k)) out[k] = v;
    }
    return out;
}

// Periodic autosave every 30 seconds
setInterval(saveAll, 30 * 1000);

// Save on clean shutdown
process.on("SIGTERM", () => { saveAll(); process.exit(0); });
process.on("SIGINT",  () => { saveAll(); process.exit(0); });

// ── Track a player in playersDB
function trackPlayer(clientId, name) {
    const now = Date.now();
    if (!playersDB[clientId]) {
        playersDB[clientId] = { name, firstSeen: now, lastSeen: now, roomsPlayed: 0, handsPlayed: 0, wins: 0 };
    } else {
        playersDB[clientId].name    = name;
        playersDB[clientId].lastSeen= now;
    }
}

// ── Record a completed match
function recordMatch(room) {
    const players = room.seats
        .map((s,i) => s ? { name: s.name, clientId: s.clientId, seat: SEAT_NAMES[i], team: (i===0||i===2)?1:2 } : null)
        .filter(Boolean);

    const matchId = room.id + '_' + room.handNumber + '_' + Date.now().toString(36);
    matchesDB.push({
        matchId,
        roomId:     room.id,
        roomName:   room.name,
        finishedAt: Date.now(),
        handNumber: room.handNumber,
        winner:     room.matchWinner,
        team1Score: room.team1Score,
        team2Score: room.team2Score,
        players,
    });

    if (matchesDB.length > 500) matchesDB = matchesDB.slice(-500);

    players.forEach(p => {
        if (playersDB[p.clientId]) {
            playersDB[p.clientId].handsPlayed += room.handNumber;
            if (p.team === room.matchWinner) playersDB[p.clientId].wins++;
            else playersDB[p.clientId].losses = (playersDB[p.clientId].losses||0) + 1;
        }
    });

    saveAll();
}

// ════════════════════════════════════════════════════════
//  ROOM STORE
// ════════════════════════════════════════════════════════
const rooms = new Map(); // roomId → RoomState

function makeRoomId() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let id = "";
    for (let i=0;i<6;i++) id += chars[Math.floor(Math.random()*chars.length)];
    return rooms.has(id) ? makeRoomId() : id;
}

function createRoom(name, password, hostClientId, hostName) {
    const id = makeRoomId();
    const room = makeBlankRoom(id, name, password);
    addRoomLog(room, `Room "${room.name}" created by ${hostName}.`, "system");
    rooms.set(id, room);
    saveAll();
    return room;
}

function makeBlankRoom(id, name, password) {
    return {
        id,
        name:    (name||"Game Room").trim().slice(0,30),
        password:(password||"").trim(),
        createdAt: Date.now(),
        lastActivity: Date.now(),

        phase: "waiting",
        deck: [],
        playerHands: [[],[],[],[]],
        seats: [null,null,null,null],

        biddingTurn: 0,
        currentBid: 15,
        highestBidder: -1,
        biddingPassedPlayers: [],

        trumpSuit: null,
        trumpRevealed: false,

        currentTrick: [],
        leadSuit: null,
        currentTurn: 0,
        team1Points: 0,
        team2Points: 0,
        trickCount: 0,
        awaitingTrickClear: false,
        matchFinished: false,

        team1Score: 0,
        team2Score: 0,
        handNumber: 0,
        pendingHandResult: null,
        matchOver: false,
        matchWinner: null,

        lastActivityPerSeat: [Date.now(),Date.now(),Date.now(),Date.now()],
        aiTakeover: [false,false,false,false],

        gameLog: [],
    };
}

// ════════════════════════════════════════════════════════
//  LOAD ROOMS FROM DISK ON STARTUP
// ════════════════════════════════════════════════════════
function loadRoomsFromDisk() {
    const snap = loadJSON(ROOMS_FILE, {});
    let count = 0;
    for (const [id, data] of Object.entries(snap)) {
        // Skip expired rooms
        if (Date.now() - (data.lastActivity||0) > ROOM_IDLE_CLEANUP) continue;

        // Restore runtime fields
        data.lastActivityPerSeat = [Date.now(),Date.now(),Date.now(),Date.now()];
        data.aiTakeover = [false,false,false,false];

        // If all seats were AI-controlled when saved (all humans had left), reset to waiting.
        // This prevents a stale mid-game from being shown when a player re-enters after restart.
        const savedAiTakeover = Array.isArray(data.aiTakeover) ? data.aiTakeover : [false,false,false,false];
        const hadNoHumans = [0,1,2,3].every(i => !data.seats[i] || savedAiTakeover[i]);
        if (["bidding","trump","playing","finished"].includes(data.phase) && hadNoHumans) {
            // Reset to clean waiting state — nobody was playing, no reason to resume
            data.phase = "waiting";
            data.seats = [null,null,null,null];
            data.playerHands = [[],[],[],[]];
            data.currentTrick = [];
            data.leadSuit = null;
            data.awaitingTrickClear = false;
            data.matchFinished = false;
            data.pendingHandResult = null;
            addRoomLog(data, "⚡ Server restarted — room reset (no active players).", "system");
            rooms.set(id, data);
            count++;
            continue;
        }

        // If game was mid-hand with some humans, mark all seats as AI-controlled so game resumes
        if (["bidding","trump","playing"].includes(data.phase)) {
            addRoomLog(data, "⚡ Server restarted — AI resumed all seats for this hand.", "system");
            data.aiTakeover = [true,true,true,true];
        }

        // Ensure required arrays exist
        if (!Array.isArray(data.playerHands)) data.playerHands = [[],[],[],[]];
        if (!Array.isArray(data.seats))       data.seats = [null,null,null,null];

        rooms.set(id, data);
        count++;

        // If mid-game, kick off AI loops after a short delay
        if (data.phase === "bidding") setTimeout(() => {
            if (rooms.get(id)?.phase === "bidding") runAiBidLoop(data);
        }, 3000);
        else if (data.phase === "trump") setTimeout(() => {
            const r = rooms.get(id);
            if (r?.phase === "trump") setTrump(r, r.highestBidder, smartTrump(r, r.highestBidder));
        }, 3000);
        else if (data.phase === "playing") setTimeout(() => {
            const r = rooms.get(id);
            if (!r || r.phase !== "playing") return;
            // If trick was completed but not resolved (server died mid-timeout), resolve it now
            if (r.awaitingTrickClear && r.currentTrick?.length === 4) {
                resolveTrick(r);
            } else {
                runAiLoop(r);
            }
        }, 3000);
    }
    console.log(`Loaded ${count} room(s) from disk.`);
}

// ════════════════════════════════════════════════════════
//  ROOM HELPERS
// ════════════════════════════════════════════════════════
function addRoomLog(room, msg, type="") {
    room.gameLog.push({msg, type});
    if (room.gameLog.length > 80) room.gameLog.shift();
    room.lastActivity = Date.now();
}

function getPlayerLabel(room, i) {
    const s = room.seats[i];
    if (room.aiTakeover[i]) return `${SEAT_NAMES[i]}(AI🤖)`;
    return s ? `${SEAT_NAMES[i]}(${s.name})` : `${SEAT_NAMES[i]}(AI)`;
}

function touchSeat(room, i) {
    room.lastActivityPerSeat[i] = Date.now();
    room.lastActivity = Date.now();
}

// ════════════════════════════════════════════════════════
//  DECK
// ════════════════════════════════════════════════════════
function createDeck() {
    const d=[];
    for (const s of SUITS) for (const v of VALUES)
        d.push({suit:s, value:v, points:POINT_MAP[v], rank:RANK_MAP[v]});
    return d;
}
function shuffle(d) {
    for (let i=d.length-1;i>0;i--) {
        const j=Math.floor(Math.random()*(i+1));
        [d[i],d[j]]=[d[j],d[i]];
    }
}
function sortHand(h) { h.sort((a,b)=>a.suit===b.suit?b.rank-a.rank:a.suit.localeCompare(b.suit)); }

// ════════════════════════════════════════════════════════
//  RESET
// ════════════════════════════════════════════════════════
function resetHand(room) {
    room.phase="waiting"; room.deck=[]; room.playerHands=[[],[],[],[]];
    room.currentTrick=[]; room.leadSuit=null; room.currentTurn=0;
    room.team1Points=0; room.team2Points=0; room.trickCount=0;
    room.awaitingTrickClear=false; room.matchFinished=false;
    room.biddingTurn=0; room.currentBid=15; room.highestBidder=-1;
    room.biddingPassedPlayers=[]; room.trumpSuit=null; room.trumpRevealed=false;
    room.pendingHandResult=null;
    room.aiTakeover=[false,false,false,false];
    room.lastActivityPerSeat=[Date.now(),Date.now(),Date.now(),Date.now()];
}

function fullReset(room) {
    resetHand(room);
    room.team1Score=0; room.team2Score=0; room.handNumber=0;
    room.matchOver=false; room.matchWinner=null; room.gameLog=[];
    addRoomLog(room,"Waiting for players. Sit in a seat to begin.","system");
    saveAll();
}

// ════════════════════════════════════════════════════════
//  START HAND
// ════════════════════════════════════════════════════════
function startHand(room) {
    resetHand(room);
    room.handNumber++;
    room.phase="bidding";
    room.deck=createDeck(); shuffle(room.deck);
    room.playerHands=[[],[],[],[]];
    for (let i=0;i<16;i++) room.playerHands[i%4].push(room.deck[i]);
    for (let i=0;i<4;i++) sortHand(room.playerHands[i]);
    room.biddingTurn=Math.floor(Math.random()*4);
    addRoomLog(room,`🃏 Hand #${room.handNumber} — BIDDING. ${getPlayerLabel(room,room.biddingTurn)} starts.`,"system");
    addRoomLog(room,`📊 Score: S+N ${room.team1Score} | W+E ${room.team2Score}`,"system");
    touchSeat(room, room.biddingTurn);
    runAiBidLoop(room);
    saveAll();
    return true;
}

// ════════════════════════════════════════════════════════
//  BIDDING
// ════════════════════════════════════════════════════════
function processBid(room, playerIndex, action, value) {
    if (room.phase!=="bidding") return false;
    if (room.biddingTurn!==playerIndex) return false;
    if (room.biddingPassedPlayers.includes(playerIndex)) return false;
    if (action==="pass") {
        room.biddingPassedPlayers.push(playerIndex);
        addRoomLog(room,`${getPlayerLabel(room,playerIndex)} passed`);
    } else if (action==="bid") {
        const bid=parseInt(value);
        if (isNaN(bid)||bid<=room.currentBid||bid<16||bid>28) return false;
        room.currentBid=bid; room.highestBidder=playerIndex;
        addRoomLog(room,`${getPlayerLabel(room,playerIndex)} bid ${bid}`);
    } else return false;

    if (room.biddingPassedPlayers.length===3 && room.highestBidder!==-1) { endBidding(room); return true; }
    if (room.biddingPassedPlayers.length===4) {
        addRoomLog(room,"All passed — restarting from 16","system");
        room.biddingPassedPlayers=[]; room.currentBid=15; room.highestBidder=-1;
    }
    advanceBidTurn(room);
    touchSeat(room, room.biddingTurn);
    runAiBidLoop(room);
    return true;
}

function advanceBidTurn(room) {
    let next=(room.biddingTurn+3)%4, loops=0; // clockwise: S→E→N→W
    while (room.biddingPassedPlayers.includes(next) && loops<5){next=(next+3)%4;loops++;}
    // If somehow all remaining seats are passed (shouldn't happen, but guard it)
    if (room.biddingPassedPlayers.includes(next)) return;
    room.biddingTurn=next;
}

function endBidding(room) {
    addRoomLog(room,`🏅 ${getPlayerLabel(room,room.highestBidder)} won bid at ${room.currentBid}!`,"system");
    room.phase="trump";
    touchSeat(room, room.highestBidder);
    const isAi=!room.seats[room.highestBidder]||room.aiTakeover[room.highestBidder];
    if (isAi) setTimeout(()=>{ const s=smartTrump(room,room.highestBidder); setTrump(room,room.highestBidder,s); },1200);
}

function runAiBidLoop(room) {
    if (room.phase!=="bidding") return;
    const seat=room.biddingTurn;
    const isAi=!room.seats[seat]||room.aiTakeover[seat];
    if (!isAi) return;
    setTimeout(()=>{
        if (room.phase!=="bidding"||room.biddingTurn!==seat) return;
        if (!room.seats[seat]||room.aiTakeover[seat]) aiBid(room,seat);
    },900);
}

function aiBid(room, i) {
    const decision = smartBid(room, i);
    processBid(room, i, decision.action, decision.value||null);
}

// ════════════════════════════════════════════════════════
//  TRUMP
// ════════════════════════════════════════════════════════
function setTrump(room, playerIndex, suit) {
    if (room.phase!=="trump"||room.highestBidder!==playerIndex||!SUITS.includes(suit)) return false;
    room.trumpSuit=suit; room.trumpRevealed=false;
    addRoomLog(room,`🔒 Trump chosen by ${getPlayerLabel(room,playerIndex)} (hidden)`,"system");
    for (let i=16;i<32;i++) room.playerHands[i%4].push(room.deck[i]);
    for (let i=0;i<4;i++) sortHand(room.playerHands[i]);
    room.phase="playing"; room.currentTurn=room.highestBidder;
    addRoomLog(room,`▶ PLAY — ${getPlayerLabel(room,room.currentTurn)} leads`,"system");
    touchSeat(room, room.currentTurn);
    runAiLoop(room);
    return true;
}

// ════════════════════════════════════════════════════════
//  PLAY
// ════════════════════════════════════════════════════════
function isValidMove(room, playerIndex, card) {
    if (!room.leadSuit) return true;
    const hasLead=room.playerHands[playerIndex].some(c=>c.suit===room.leadSuit);
    return !hasLead || card.suit===room.leadSuit;
}

function playCard(room, playerIndex, cardIndex) {
    const hand=room.playerHands[playerIndex];
    const card=hand[cardIndex];
    if (!card||!isValidMove(room,playerIndex,card)) return false;
    hand.splice(cardIndex,1);
    if (!room.leadSuit) room.leadSuit=card.suit;
    if (!room.trumpRevealed&&room.trumpSuit&&card.suit===room.trumpSuit&&room.leadSuit!==room.trumpSuit) {
        room.trumpRevealed=true;
        addRoomLog(room,`🃏 TRUMP REVEALED! ${room.trumpSuit} — played by ${getPlayerLabel(room,playerIndex)}`,"system");
    }
    room.currentTrick.push({player:playerIndex,card});
    addRoomLog(room,`${getPlayerLabel(room,playerIndex)} played ${card.value}${card.suit}`);
    room.currentTurn=(playerIndex+3)%4; // clockwise: S(0)→E(3)→N(2)→W(1)→S(0)
    if (room.currentTrick.length===4) { room.awaitingTrickClear=true; setTimeout(()=>resolveTrick(room),1500); }
    else touchSeat(room, room.currentTurn);
    return true;
}

function runAiLoop(room) {
    if (room.phase!=="playing"||room.awaitingTrickClear||room.matchFinished||room.matchOver) return;
    const seat=room.currentTurn;
    if (room.seats[seat]&&!room.aiTakeover[seat]) return;
    setTimeout(()=>{
        if (room.phase!=="playing"||room.awaitingTrickClear) return;
        const cur=room.currentTurn;
        if (room.seats[cur]&&!room.aiTakeover[cur]) return;
        // Smart trump reveal check
        if (!room.trumpRevealed && room.trumpSuit && room.leadSuit) {
            const hasLead = room.playerHands[cur].some(c=>c.suit===room.leadSuit);
            if (!hasLead && shouldAiRevealTrump(room, cur)) {
                room.trumpRevealed=true;
                addRoomLog(room,`🃏 TRUMP REVEALED! ${room.trumpSuit} — by ${getPlayerLabel(room,cur)}`,"system");
            }
        }
        const card=smartPlayCard(room,cur);
        const idx=room.playerHands[cur].findIndex(c=>c.suit===card.suit&&c.value===card.value);
        playCard(room,cur,idx);
        runAiLoop(room);
    },900);
}

// ════════════════════════════════════════════════════════
//  SMART AI ENGINE
// ════════════════════════════════════════════════════════

function evaluateHand(hand) {
    let score = 0;
    const suitGroups = {};
    for (const c of hand) {
        if (!suitGroups[c.suit]) suitGroups[c.suit] = [];
        suitGroups[c.suit].push(c);
    }
    for (const c of hand) {
        if      (c.value==='J')  score += 14;
        else if (c.value==='9')  score += 10;
        else if (c.value==='A')  score += 7;
        else if (c.value==='10') score += 6;
        else if (c.value==='K')  score += 4;
        else if (c.value==='Q')  score += 2;
    }
    for (const [, cards] of Object.entries(suitGroups)) {
        if (cards.length >= 4) score += (cards.length - 3) * 5;
        if (cards.length === 1) score += 4;
    }
    const voids = 4 - Object.keys(suitGroups).length;
    score += voids * 8;
    return score;
}

function bestTrumpSuit(hand) {
    const suitScore = {};
    for (const suit of SUITS) {
        const cards = hand.filter(c => c.suit === suit);
        let s = 0;
        for (const c of cards) {
            if      (c.value==='J')  s += 20;
            else if (c.value==='9')  s += 14;
            else if (c.value==='A')  s += 8;
            else if (c.value==='10') s += 6;
            else if (c.value==='K')  s += 4;
            else if (c.value==='Q')  s += 2;
            s += cards.length * 2;
        }
        suitScore[suit] = s;
    }
    return SUITS.reduce((best, s) => suitScore[s] > suitScore[best] ? s : best, SUITS[0]);
}

function smartBid(room, seatIndex) {
    const hand      = room.playerHands[seatIndex];
    const strength  = evaluateHand(hand);
    const myTeam    = (seatIndex===0||seatIndex===2) ? 1 : 2;
    const myScore   = myTeam===1 ? room.team1Score : room.team2Score;
    const oppScore  = myTeam===1 ? room.team2Score : room.team1Score;
    const current   = room.currentBid;
    const partner   = (seatIndex+2)%4;
    const partnerBid      = room.highestBidder === partner;
    const opponentBidding = !partnerBid && room.highestBidder >= 0;
    const desperate   = myScore <= -4 || (oppScore >= 5 && myScore < oppScore);
    const comfortable = myScore >= 3 && (myScore - oppScore) >= 2;
    const needPoints  = oppScore >= 4;

    let baseBid;
    if      (strength >= 70) baseBid = 22;
    else if (strength >= 55) baseBid = 20;
    else if (strength >= 42) baseBid = 18;
    else if (strength >= 30) baseBid = 17;
    else                     baseBid = 16;

    if (desperate)   baseBid += 2;
    if (comfortable) baseBid -= 1;
    if (needPoints)  baseBid += 1;
    if (partnerBid && strength >= 40 && current < baseBid)
        baseBid = Math.min(baseBid, current + 2);

    baseBid = Math.min(baseBid, 28);

    if (baseBid <= current) {
        if (opponentBidding && desperate && strength >= 35)
            return { action:'bid', value: Math.min(current+1, 28) };
        return { action:'pass' };
    }
    if (strength < 28 && current >= 24) return { action:'pass' };
    return { action:'bid', value: baseBid };
}

function smartTrump(room, seatIndex) {
    return bestTrumpSuit(room.playerHands[seatIndex]);
}

function smartPlayCard(room, seatIndex) {
    const hand   = room.playerHands[seatIndex];
    const trick  = room.currentTrick;
    const trump  = room.trumpSuit;
    const lead   = room.leadSuit;
    const partner= (seatIndex+2)%4;
    const myTeam = (seatIndex===0||seatIndex===2) ? 1 : 2;
    const myScore= myTeam===1 ? room.team1Score : room.team2Score;

    const valid = hand.filter(c => {
        if (!lead) return true;
        const hasLead = hand.some(x=>x.suit===lead);
        return !hasLead || c.suit===lead;
    });
    if (!valid.length) return hand[0];

    const trickPoints = trick.reduce((s,t)=>s+t.card.points,0);
    const trickLen    = trick.length;

    function cardPower(c) {
        let p = c.rank;
        if (trump && c.suit===trump) p += 100;
        return p;
    }
    function trickWinner(t) {
        let best=-1, winner=-1;
        for (const p of t) {
            let sc = p.card.rank;
            if (trump && p.card.suit===trump) sc += 100;
            else if (lead && p.card.suit!==lead) sc = -1;
            if (sc>best){best=sc;winner=p.player;}
        }
        return winner;
    }

    const byAsc  = [...valid].sort((a,b)=>cardPower(a)-cardPower(b));
    const byDesc = [...byAsc].reverse();
    const currentWinner = trick.length>0 ? trickWinner(trick) : -1;
    const partnerWinning= currentWinner===partner;
    const weWinning     = currentWinner===seatIndex || (
        trick.length>0 && ((currentWinner===0||currentWinner===2)===(myTeam===1))
    );

    function canBeat(c) {
        return trickWinner([...trick,{player:seatIndex,card:c}])===seatIndex;
    }
    const beaters = valid.filter(canBeat).sort((a,b)=>cardPower(a)-cardPower(b));

    // Leading
    if (trickLen===0) {
        const trumpCards = valid.filter(c=>trump&&c.suit===trump);
        const nonTrump   = valid.filter(c=>!trump||c.suit!==trump);
        if (room.trumpRevealed && trumpCards.length>=2) {
            const jn = trumpCards.find(c=>c.value==='J'||c.value==='9');
            if (jn) return jn;
        }
        const aces = nonTrump.filter(c=>c.value==='A');
        if (aces.length) return aces[0];
        const tens = nonTrump.filter(c=>c.value==='10');
        if (tens.length && trickPoints===0) return tens[0];
        if (myScore<=-4 && trumpCards.length) return byDesc[0];
        const safe = nonTrump.filter(c=>c.points===0).sort((a,b)=>a.rank-b.rank);
        return safe.length ? safe[0] : byAsc[0];
    }

    // Following: partner winning — dump points on them
    if (partnerWinning) {
        const pts = valid.filter(c=>c.points>0).sort((a,b)=>b.points-a.points);
        if (pts.length) return pts[0];
        return byAsc[0];
    }

    // Last to play
    if (trickLen===3) {
        if (weWinning||partnerWinning) {
            const pts = valid.filter(c=>c.points>0).sort((a,b)=>b.points-a.points);
            return pts.length ? pts[0] : byAsc[0];
        }
        if (beaters.length) return beaters[0];
        const dump = valid.filter(c=>c.points===0).sort((a,b)=>a.rank-b.rank);
        return dump.length ? dump[0] : byAsc[0];
    }

    // Middle
    if (beaters.length) {
        if (trickPoints>=2 || myScore<=-3) return beaters[0];
        const dump = valid.filter(c=>c.points===0).sort((a,b)=>a.rank-b.rank);
        if (dump.length) return dump[0];
        return beaters[0];
    }
    const dumpable = valid.filter(c=>c.points===0).sort((a,b)=>a.rank-b.rank);
    return dumpable.length ? dumpable[0] : byAsc[0];
}

function shouldAiRevealTrump(room, seatIndex) {
    if (!room.leadSuit||room.trumpRevealed||!room.trumpSuit) return false;
    const hasLead = room.playerHands[seatIndex].some(c=>c.suit===room.leadSuit);
    if (hasLead) return false;
    const trickPoints = room.currentTrick.reduce((s,t)=>s+t.card.points,0);
    const trumpCards  = room.playerHands[seatIndex].filter(c=>c.suit===room.trumpSuit);
    const hasStrong   = trumpCards.some(c=>c.value==='J'||c.value==='9'||c.value==='A');
    return hasStrong && trickPoints>=2;
}

function resolveTrick(room) {
    if (!room.awaitingTrickClear) return;
    let winner=-1, best=-1;
    for (const p of room.currentTrick) {
        let sc=p.card.rank;
        if (p.card.suit===room.trumpSuit) sc+=100;
        else if (p.card.suit!==room.leadSuit) sc=-1;
        if (sc>best){best=sc;winner=p.player;}
    }
    let pts=0; room.currentTrick.forEach(t=>pts+=t.card.points);
    if (winner===0||winner===2) room.team1Points+=pts; else room.team2Points+=pts;
    addRoomLog(room,`🏆 ${getPlayerLabel(room,winner)} won trick`);
    room.currentTrick=[]; room.leadSuit=null;
    room.currentTurn=winner; room.awaitingTrickClear=false; room.trickCount++;
    if (room.trickCount>=8) { endHand(room); return; }
    touchSeat(room, room.currentTurn);
    runAiLoop(room);
}

// ════════════════════════════════════════════════════════
//  END HAND / MATCH SCORING
// ════════════════════════════════════════════════════════
function endHand(room) {
    room.phase="finished"; room.matchFinished=true;
    const bidTeam=(room.highestBidder===0||room.highestBidder===2)?1:2;
    const bidPts=bidTeam===1?room.team1Points:room.team2Points;
    const made=bidPts>=room.currentBid;
    let d1=0,d2=0;
    if (made){ if(bidTeam===1)d1=+1;else d2=+1; addRoomLog(room,`✅ Team ${bidTeam} made bid of ${room.currentBid}`,"system"); }
    else     { if(bidTeam===1)d1=-1;else d2=-1; addRoomLog(room,`❌ Team ${bidTeam} failed bid of ${room.currentBid}`,"system"); }
    room.team1Score+=d1; room.team2Score+=d2;
    room.pendingHandResult={bidTeam,bidMade:made,delta1:d1,delta2:d2,handNumber:room.handNumber};
    addRoomLog(room,`📊 Match: S+N ${room.team1Score} | W+E ${room.team2Score}`,"system");
    checkMatchOver(room);
    saveAll();
    if (!room.matchOver) setTimeout(()=>{ if(room.phase==="finished"&&!room.matchOver) startHand(room); },3500);
}

function checkMatchOver(room) {
    const t1=room.team1Score, t2=room.team2Score;
    if (t1>=6||t2<=-6){
        room.matchOver=true; room.matchWinner=1; room.phase="matchOver";
        addRoomLog(room,`🏆 South+North win! (${t1} vs ${t2})`,"system");
        recordMatch(room);
    } else if(t2>=6||t1<=-6){
        room.matchOver=true; room.matchWinner=2; room.phase="matchOver";
        addRoomLog(room,`🏆 West+East win! (${t1} vs ${t2})`,"system");
        recordMatch(room);
    }
}

// ════════════════════════════════════════════════════════
//  SEAT MANAGEMENT
// ════════════════════════════════════════════════════════
function sitPlayer(room, seat, clientId, name) {
    for (let i=0;i<4;i++) if (room.seats[i]?.clientId===clientId) room.seats[i]=null;
    room.seats[seat]={clientId, name};
    room.aiTakeover[seat]=false;
    touchSeat(room, seat);
    addRoomLog(room,`${name} sat at ${SEAT_NAMES[seat]}`,"system");
    trackPlayer(clientId, name);
    playersDB[clientId].roomsPlayed++;
    saveAll();
}

function standPlayer(room, clientId) {
    for (let i=0;i<4;i++) {
        if (room.seats[i]?.clientId===clientId) {
            addRoomLog(room,`${room.seats[i].name} left ${SEAT_NAMES[i]}`,"system");
            room.seats[i]=null;
            // If a game is in progress, mark seat as AI so the game continues uninterrupted
            if (["bidding","trump","playing"].includes(room.phase) && !room.matchOver) {
                room.aiTakeover[i]=true;
                addRoomLog(room,`🤖 AI took over ${SEAT_NAMES[i]}`,"system");
                // Resume immediately if the game was waiting on this exact seat
                if (room.phase==="bidding" && room.biddingTurn===i) {
                    setTimeout(()=>aiBid(room,i),400);
                } else if (room.phase==="trump" && room.highestBidder===i) {
                    setTimeout(()=>setTrump(room,i,smartTrump(room,i)),600);
                } else if (room.phase==="playing" && room.currentTurn===i && !room.awaitingTrickClear) {
                    setTimeout(()=>runAiLoop(room),400);
                }
            }
        }
    }
    saveAll();
}

// ════════════════════════════════════════════════════════
//  AI TAKEOVER WATCHDOG
// ════════════════════════════════════════════════════════
function checkAllRooms() {
    for (const room of rooms.values()) {
        if (!["bidding","trump","playing"].includes(room.phase)||room.matchOver) continue;
        let activeSeat=-1;
        if (room.phase==="bidding") activeSeat=room.biddingTurn;
        else if (room.phase==="playing") activeSeat=room.currentTurn;
        else if (room.phase==="trump") activeSeat=room.highestBidder;
        if (activeSeat===-1) continue;
        const s=room.seats[activeSeat];
        if (!s||room.aiTakeover[activeSeat]) continue;
        const elapsed=Date.now()-room.lastActivityPerSeat[activeSeat];
        if (elapsed>=AI_TAKEOVER_MS) {
            room.aiTakeover[activeSeat]=true;
            room.seats[activeSeat]=null;   // eject player → they become a visitor immediately
            addRoomLog(room,`⏰ ${s.name} unresponsive — AI took over ${SEAT_NAMES[activeSeat]}`,"system");
            if (room.phase==="bidding") setTimeout(()=>aiBid(room,activeSeat),300);
            else if (room.phase==="trump") setTimeout(()=>setTrump(room,activeSeat,smartTrump(room,activeSeat)),600);
            else runAiLoop(room);
        }
    }
}
setInterval(checkAllRooms, 10000);

// ════════════════════════════════════════════════════════
//  ROOM CLEANUP (idle 2h)
// ════════════════════════════════════════════════════════
setInterval(()=>{
    const now=Date.now();
    for (const [id,room] of rooms.entries()) {
        if (now-room.lastActivity>ROOM_IDLE_CLEANUP) {
            rooms.delete(id);
            console.log(`Cleaned up room ${id}`);
            saveAll();
        }
    }
}, 10*60*1000);

// ════════════════════════════════════════════════════════
//  STATE SERIALISATION
// ════════════════════════════════════════════════════════
function publicRoomState(room, clientId) {
    const st = Object.assign({}, room);
    if (!st.trumpRevealed && st.phase==="playing") {
        const isWinner = clientId && st.seats[st.highestBidder]?.clientId===clientId;
        if (!isWinner) st.trumpSuit=null;
    }
    st.deck=[];
    const mySeat = clientId ? st.seats.findIndex(s=>s?.clientId===clientId) : -1;
    st.playerHands = st.playerHands.map((h,i)=> i===mySeat ? h : h.map(()=>({})));
    return st;
}

function lobbyList() {
    const list=[];
    for (const room of rooms.values()) {
        // Per-seat detail: true=human, false=AI/empty
        const playerDetails = room.seats.map((s,i)=> s && !room.aiTakeover[i] ? s.name : null);
        const humanCount = playerDetails.filter(Boolean).length;
        list.push({
            id:              room.id,
            name:            room.name,
            passwordProtected: !!room.password,
            phase:           room.phase,
            players:         humanCount,
            playerDetails,
            handNumber:      room.handNumber,
            createdAt:       room.createdAt,
        });
    }
    return list.sort((a,b)=>b.createdAt-a.createdAt);
}

// ════════════════════════════════════════════════════════
//  HTTP SERVER
// ════════════════════════════════════════════════════════
const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://localhost`);
    const pathname = u.pathname;

    const json = (data, code=200) => {
        res.writeHead(code,{"Content-Type":"application/json"});
        res.end(JSON.stringify(data));
    };
    const err = (msg,code=400) => json({error:msg},code);

    const body = () => new Promise(resolve=>{
        let b=""; req.on("data",c=>b+=c); req.on("end",()=>resolve(JSON.parse(b||"{}")));
    });

    const getRoom = (id) => {
        if (!id) return null;
        return rooms.get(id.toUpperCase())||null;
    };

    if ((pathname==="/"||pathname==="/index.html") && req.method==="GET") {
        fs.readFile(path.join(__dirname,"lobby.html"),(e,c)=>{
            if (e){res.writeHead(500);res.end("Cannot load lobby.html");return;}
            res.writeHead(200,{"Content-Type":"text/html"}); res.end(c);
        }); return;
    }

    if (pathname==="/game" && req.method==="GET") {
        fs.readFile(path.join(__dirname,"user.html"),(e,c)=>{
            if (e){res.writeHead(500);res.end("Cannot load user.html");return;}
            res.writeHead(200,{"Content-Type":"text/html"}); res.end(c);
        }); return;
    }

    if (pathname==="/api/lobby" && req.method==="GET") { json(lobbyList()); return; }

    // ── PWA static files ────────────────────────────────
    if (pathname==="/manifest.json" && req.method==="GET") {
        fs.readFile(path.join(__dirname,"manifest.json"),(e,c)=>{
            if(e){res.writeHead(404);res.end("Not found");return;}
            res.writeHead(200,{"Content-Type":"application/manifest+json","Cache-Control":"public,max-age=86400"});res.end(c);
        }); return;
    }
    if (pathname==="/sw.js" && req.method==="GET") {
        fs.readFile(path.join(__dirname,"sw.js"),(e,c)=>{
            if(e){res.writeHead(404);res.end("Not found");return;}
            res.writeHead(200,{"Content-Type":"application/javascript","Cache-Control":"no-cache"});res.end(c);
        }); return;
    }
    if (pathname.startsWith("/icons/") && req.method==="GET") {
        const iconFile = path.join(__dirname, "icons", path.basename(pathname));
        fs.readFile(iconFile,(e,c)=>{
            if(e){res.writeHead(404);res.end("Not found");return;}
            res.writeHead(200,{"Content-Type":"image/png","Cache-Control":"public,max-age=604800"});res.end(c);
        }); return;
    }

    // ── GET /api/stats  (players + match history)
    if (pathname==="/api/stats" && req.method==="GET") {
        const fiveMin = 5 * 60 * 1000;
        let activeUsers = 0;
        for (const room of rooms.values()) {
            room.seats.forEach((s,i) => {
                if (s && !room.aiTakeover[i] && Date.now()-room.lastActivityPerSeat[i]<fiveMin) activeUsers++;
            });
        }
        const activeRooms = [...rooms.values()].filter(r=>['bidding','trump','playing'].includes(r.phase)).length;
        json({
            totalMatches: matchesDB.length,
            activeUsers,
            activeRooms,
            recentMatches: matchesDB.slice(-20).reverse(),
            topPlayers: Object.entries(playersDB)
                .map(([id,p])=>({name:p.name, wins:p.wins||0, losses:p.losses||0, handsPlayed:p.handsPlayed||0}))
                .filter(p=>(p.wins||0)+(p.losses||0)>0)
                .sort((a,b)=>{
                    if (b.wins!==a.wins) return b.wins-a.wins;
                    const wr=v=>v.wins/(v.wins+v.losses||1);
                    return wr(b)-wr(a);
                })
                .slice(0,20),
        }); return;
    }

    if (pathname==="/api/room/create" && req.method==="POST") {
        body().then(b=>{
            const room=createRoom(b.roomName, b.password, b.clientId, b.hostName||"Host");
            json({roomId:room.id});
        }); return;
    }

    if (pathname==="/api/room/join" && req.method==="POST") {
        body().then(b=>{
            const room=getRoom(b.roomId);
            if (!room) return err("Room not found",404);
            if (room.password && room.password!==b.password) return err("Wrong password",403);
            json({ok:true, roomId:room.id, roomName:room.name});
        }); return;
    }

    if (pathname==="/api/state" && req.method==="GET") {
        const room=getRoom(u.searchParams.get("room"));
        if (!room) return err("Room not found",404);
        const clientId=u.searchParams.get("clientId")||null;
        json(publicRoomState(room,clientId)); return;
    }

    const gameRoutes = ["/api/start","/api/sit","/api/stand","/api/play","/api/bid","/api/trump","/api/reveal-trump"];
    if (gameRoutes.includes(pathname) && req.method==="POST") {
        body().then(b=>{
            const room=getRoom(b.roomId);
            if (!room) return err("Room not found",404);
            const {clientId,seat,cardIndex,action,value,suit}=b;

            if (pathname==="/api/start") {
                // Must have at least one real human seated to start
                const hasHuman=room.seats.some((s,i)=>s&&!room.aiTakeover[i]);
                if (!hasHuman) return json(publicRoomState(room,clientId));
                if (room.matchOver) {
                    resetHand(room);
                    room.team1Score=0; room.team2Score=0; room.handNumber=0;
                    room.matchOver=false; room.matchWinner=null; room.gameLog=[];
                    addRoomLog(room,"🆕 New match started!","system");
                    saveAll();
                }
                startHand(room);
                return json(publicRoomState(room,clientId));
            }
            if (pathname==="/api/sit") {
                const seatN=parseInt(seat), name=(b.name||"Player").trim();
                const s=room.seats[seatN];
                if (s && s.clientId!==clientId && !room.aiTakeover[seatN]) return err("Seat taken");
                sitPlayer(room,seatN,clientId,name);
                return json(publicRoomState(room,clientId));
            }
            if (pathname==="/api/stand") {
                standPlayer(room,clientId);
                return json(publicRoomState(room,clientId));
            }
            if (pathname==="/api/play") {
                const seatN=parseInt(seat), ci=parseInt(cardIndex);
                if (room.phase==="playing"&&room.seats[seatN]?.clientId===clientId&&!room.aiTakeover[seatN]&&room.currentTurn===seatN&&!room.awaitingTrickClear&&!room.matchFinished) {
                    touchSeat(room,seatN); playCard(room,seatN,ci); runAiLoop(room);
                }
                return json(publicRoomState(room,clientId));
            }
            if (pathname==="/api/bid") {
                const seatN=parseInt(seat);
                if (room.phase==="bidding"&&room.seats[seatN]?.clientId===clientId&&!room.aiTakeover[seatN]&&room.biddingTurn===seatN&&!room.biddingPassedPlayers.includes(seatN)) {
                    touchSeat(room,seatN); processBid(room,seatN,action,value);
                }
                return json(publicRoomState(room,clientId));
            }
            if (pathname==="/api/trump") {
                const seatN=parseInt(seat);
                if (room.phase==="trump"&&room.seats[seatN]?.clientId===clientId&&!room.aiTakeover[seatN]&&room.highestBidder===seatN) {
                    touchSeat(room,seatN); setTrump(room,seatN,suit);
                }
                return json(publicRoomState(room,clientId));
            }
            if (pathname==="/api/reveal-trump") {
                const seatN=parseInt(seat);
                if (room.phase==="playing"&&room.seats[seatN]?.clientId===clientId&&!room.aiTakeover[seatN]&&!room.trumpRevealed&&room.currentTurn===seatN&&!room.awaitingTrickClear) {
                    // Only allow reveal if player has no lead suit cards (and a lead suit exists)
                    const hand=room.playerHands[seatN];
                    const hasLead=room.leadSuit&&hand.some(c=>c.suit===room.leadSuit);
                    if (!hasLead&&room.leadSuit) {
                        room.trumpRevealed=true;
                        addRoomLog(room,`🃏 TRUMP REVEALED! ${room.trumpSuit} — by ${getPlayerLabel(room,seatN)}`,'system');
                    }
                }
                return json(publicRoomState(room,clientId));
            }
        }); return;
    }

    res.writeHead(404); res.end("404");
});

// ════════════════════════════════════════════════════════
//  STARTUP
// ════════════════════════════════════════════════════════
loadRoomsFromDisk();

// Ensure all data files exist on disk immediately at startup
if (!fs.existsSync(ROOMS_FILE))   saveJSON(ROOMS_FILE,  {});
if (!fs.existsSync(PLAYERS_FILE)) saveJSON(PLAYERS_FILE, {});
if (!fs.existsSync(MATCHES_FILE)) saveJSON(MATCHES_FILE, []);
console.log(`Data files at: ${DATA_DIR}`);

server.listen(PORT, ()=>console.log(`29 Card Game server on http://localhost:${PORT}`));

