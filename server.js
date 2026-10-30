const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { openStore } = require('./storage');
require('dotenv').config();

let serverStarted = false;
process.on('uncaughtException', (err) => {
  if (!serverStarted) {
    console.error('startup err: ', err);
    process.exit(1);
  }
  console.error('server still up but error: ', err);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', 1);

app.use(express.json());

function rateLimit(windowMs, maxRequests, message) {
  const hits = new Map();
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const timestamps = (hits.get(ip) || []).filter(t => now - t < windowMs);
    if (timestamps.length >= maxRequests) {
      return res.status(429).json({ message: message || 'Too many requests, please slow down and try again shortly.' });
    }
    timestamps.push(now);
    hits.set(ip, timestamps);
    next();
  };
}
const loginRateLimit = rateLimit(15 * 60 * 1000, 10, 'Too many login attempts. Please wait a few minutes and try again.');
const signupRateLimit = rateLimit(60 * 60 * 1000, 5, 'Too many accounts created from this connection. Please try again later.');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LEGACY_JSON_PATH = path.join(DATA_DIR, 'db.json');
const store = openStore(DATA_DIR);

function defaultDB() {
  return {
    users: {},
    clans: {},
    competition: {
      cycleNumber: 1,
      cycleStart: Date.now(),
      clanScores: {},
      individualScores: {}
    },
    reports: [
      { id: 1, author: "ascend", message: "buy it", reportedBy: "hthelegend" },
      { id: 2, author: "hthelegend", message: "Hi", reportedBy: "cosmicdragonyt" }
    ],
    news: [],
    trades: [],
    listings: [],
    globalChat: [],
    sessions: {},
    ipBans: {},
    meta: {},
    eventItems: []
  };
}

function loadDB() {
  let loaded = store.load();
  let importedJson = false;
  if (!loaded && fs.existsSync(LEGACY_JSON_PATH)) {
    loaded = JSON.parse(fs.readFileSync(LEGACY_JSON_PATH, 'utf8'));
    importedJson = true;
  }
  if (!loaded) return { data: defaultDB(), importedJson };

  {
    const fresh = defaultDB();
    loaded.users = loaded.users || {};
    loaded.clans = loaded.clans || {};
    loaded.competition = loaded.competition || fresh.competition;
    loaded.reports = loaded.reports || fresh.reports;
    loaded.news = loaded.news || [];
    loaded.trades = loaded.trades || [];
    loaded.listings = loaded.listings || [];
    loaded.globalChat = loaded.globalChat || [];
    loaded.sessions = loaded.sessions || {};
    loaded.ipBans = loaded.ipBans || {};
    loaded.meta = loaded.meta || {};
    loaded.eventItems = loaded.eventItems || [];
    Object.values(loaded.clans).forEach(c => {
      if (!c.inviteCode) c.inviteCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      if (c.iconImage === undefined || (c.iconImage && !isLocalImagePath(c.iconImage))) c.iconImage = null;
    });
    Object.values(loaded.users || {}).forEach(u => {
      if (u.clanId === undefined) u.clanId = null;
      if (!u.hourlyDeposit) u.hourlyDeposit = { amount: 0, windowStart: 0 };
      if (u.booster === undefined) u.booster = null;
      if (!u.theme) u.theme = 'orange';
      if (u.isOwner === undefined) u.isOwner = false;
      if (u.avatar === undefined || (u.avatar && !isLocalImagePath(u.avatar))) u.avatar = null;
      if (u.packsOpened === undefined) u.packsOpened = 0;
      if (u.messagesSent === undefined) u.messagesSent = 0;
      if (!u.friends) u.friends = [];
      if (!u.incomingRequests) u.incomingRequests = [];
      if (!u.outgoingRequests) u.outgoingRequests = [];
      if (u.equippedBadge === undefined) u.equippedBadge = null;
      if (u.lastDailySpinAt === undefined) u.lastDailySpinAt = null;
      if (u.rubies === undefined) u.rubies = 0;
      if (!Number.isFinite(u.tokens)) { console.warn('reset non-numeric token balance for', u.username); u.tokens = 0; }
      if (!Number.isFinite(u.rubies)) u.rubies = 0;
      if (u.grantedBadges === undefined) u.grantedBadges = [];
      if (!Array.isArray(u.ipHashes)) u.ipHashes = [];
      delete u.bannedIP;
      delete u.bannedID;
    });
  }
  return { data: loaded, importedJson };
}
function saveDB() {
  try {
    store.save(db);
  } catch (err) {
    console.error('db save failed', store.path, '-', err.message);
  }
}

const loadedDB = loadDB();
let db = loadedDB.data;
if (loadedDB.importedJson) {
  store.importJsonIfPresent(db, LEGACY_JSON_PATH);
  console.log('imported ' + Object.keys(db.users).length + ' accounts from db.json into ${store.path}');
}

function own(obj, key) {
  return (obj && typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key)) ? obj[key] : undefined;
}

function canAfford(balance, cost) {
  return Number.isFinite(balance) && Number.isFinite(cost) && cost >= 0 && balance >= cost;
}
const MAX_TOKEN_AMOUNT = 1e12;

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const UPLOAD_MAX_BYTES = 512 * 1024;
const UPLOAD_URL_PREFIX = 'uploads/';
const UPLOAD_NAME_RE = /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/;
const UPLOAD_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function detectImageExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function saveUpload(buf) {
  const ext = detectImageExt(buf);
  if (!ext) return null;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return UPLOAD_URL_PREFIX + name;
}

function removeUploadIfUnused(imagePath) {
  if (typeof imagePath !== 'string' || !imagePath.startsWith(UPLOAD_URL_PREFIX)) return;
  const name = imagePath.slice(UPLOAD_URL_PREFIX.length);
  if (!UPLOAD_NAME_RE.test(name)) return;
  const inUse = Object.values(db.users).some(u => u.avatar === imagePath) ||
    Object.values(db.clans).some(c => c.iconImage === imagePath);
  if (inUse) return;
  try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); } catch (e) {}
}

function isLocalImagePath(p) {
  return typeof p === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.\-/]*$/.test(p) && !p.includes('..') && !p.includes('//');
}

function isBanned(user) {
  if (!user || !user.banned || !user.banned.active) return false;
  if (user.banned.until && Date.now() > user.banned.until) {
    user.banned = { active: false };
    return false;
  }
  return true;
}

const OWNER_USERNAMES = ['Aaron', 'AyAyRon'].map(u => u.toLowerCase());

const OWNER_SETUP_CODE = process.env.OWNER_SETUP_CODE || null;
const RESERVED_USERNAMES = [...OWNER_USERNAMES];

const STARTING_TOKENS = 100;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

const PACK_CONFIGS = {
  spacePack: { label: "Space Pack", cost: 15, rates: [
    { name: "Earth", item: "blooks/Earth.webp", type: "uncommon", weight: 25 },
    { name: "Meteor", item: "blooks/Meteor.webp", type: "uncommon", weight: 25 },
    { name: "Stars", item: "blooks/Stars.webp", type: "uncommon", weight: 25 },
    { name: "Alien", item: "blooks/Alien.webp", type: "uncommon", weight: 25 },
    { name: "Planet", item: "blooks/Planet.webp", type: "rare", weight: 22 },
    { name: "UFO", item: "blooks/UFO.webp", type: "rare", weight: 22 },
    { name: "Spaceship", item: "blooks/Spaceship.webp", type: "epic", weight: 24 },
    { name: "Astronaut", item: "blooks/Astronaut.webp", type: "legendary", weight: 3 },
    { name: "Space Terminal", item: "blooks/Space Terminal.webp", type: "supreme", weight: 0.001 },
    { name: "Space Debugger", item: "blooks/Space Debugger.webp", type: "chroma", weight: 0.0855 },
    { name: "Pink Astronaut", item: "blooks/Pink Astronaut.webp", type: "chroma", weight: 0.0855 },
    { name: "Red Astronaut", item: "blooks/Red Astronaut.webp", type: "chroma", weight: 0.0855 },
    { name: "Orange Astronaut", item: "blooks/Orange Astronaut.webp", type: "chroma", weight: 0.0855 },
    { name: "Yellow Astronaut", item: "blooks/Yellow Astronaut.webp", type: "chroma", weight: 0.0855 },
    { name: "Lime Astronaut", item: "blooks/Lime Astronaut.webp", type: "chroma", weight: 0.0855 },
    { name: "Green Astronaut", item: "blooks/Green Astronaut.webp", type: "chroma", weight: 0.0855 },
    { name: "Cyan Astronaut", item: "blooks/Cyan Astronaut.webp", type: "chroma", weight: 0.0855 },
    { name: "Blue Astronaut", item: "blooks/Blue Astronaut.webp", type: "chroma", weight: 0.0855 },
    { name: "Purple Astronaut", item: "blooks/Purple Astronaut.webp", type: "chroma", weight: 0.0855 },
    { name: "Brown Astronaut", item: "blooks/Brown Astronaut.webp", type: "chroma", weight: 0.0855 },
    { name: "Black Astronaut", item: "blooks/Black Astronaut.webp", type: "chroma", weight: 0.0855 },
    { name: "Tim the Alien", item: "blooks/Tim The Alien.webp", type: "mystical", weight: 0.00171},
    { name: "Rainbow Astronaut", item: "blooks/Rainbow Astronaut.webp", type: "mystical", weight: 0.00171 }
  ] },
  medievalPack: { label: "Medieval Pack", cost: 25, rates: [
    { name: "Elf", item: "blooks/Elf.webp", type: "uncommon", weight: 20 },
    { name: "Fairy", item: "blooks/Fairy.webp", type: "uncommon", weight: 20 },
    { name: "Slime Monster", item: "blooks/Slime Monster.webp", type: "uncommon", weight: 20 },
    { name: "Witch", item: "blooks/Witch.webp", type: "uncommon", weight: 20 },
    { name: "Wizard", item: "blooks/Wizard.webp", type: "uncommon", weight: 20 },
    { name: "Dragon", item: "blooks/Dragon.webp", type: "rare", weight: 15 },
    { name: "Jester", item: "blooks/Jester.webp", type: "rare", weight: 15 },
    { name: "Queen", item: "blooks/Queen.webp", type: "rare", weight: 15 },
    { name: "Unicorn", item: "blooks/Unicorn.webp", type: "epic", weight: 24 },
    { name: "King", item: "blooks/King.webp", type: "legendary", weight: 5 },
    { name: "Phantom King", item: "blooks/Phantom King.webp", type: "mystical", weight: 0.00174 }
  ] },
  blizzardPack: { label: "Blizzard Pack", cost: 40, disabled: true, rates: [ { name: "Snowman", item: "snowman.png", type: "common", weight: 50 }, { name: "Penguin", item: "penguin.png", type: "rare", weight: 35 }, { name: "Frost Giant", item: "frostgiant.png", type: "legendary", weight: 3 } ] },
  cyberPack: { label: "Bot Pack", cost: 50, rates: [
    { name: "Angry Bot", item: "blooks/Angry Bot.webp", type: "uncommon", weight: 20 },
    { name: "Happy Bot", item: "blooks/Happy Bot.webp", type: "uncommon", weight: 20 },
    { name: "Lil Bot", item: "blooks/Lil Bot.webp", type: "uncommon", weight: 20 },
    { name: "Lovely Bot", item: "blooks/Lovely Bot.webp", type: "uncommon", weight: 20 },
    { name: "Buddy Bot", item: "blooks/Buddy Bot.webp", type: "rare", weight: 15 },
    { name: "Watson", item: "blooks/Watson.webp", type: "rare", weight: 15 },
    { name: "Brainy Bot", item: "blooks/Brainy Bot.webp", type: "epic", weight: 24 },
    { name: "Mega Bot", item: "blooks/Mega Bot.webp", type: "legendary", weight: 0.4 }
  ] },
  breakfastpack: { label: "Breakfast Pack", cost: 50, rates: [
    { name: "Toast", item: "blooks/Toast.webp", type: "uncommon", weight: 20 },
    { name: "Cereal", item: "blooks/Cereal.webp", type: "uncommon", weight: 20 },
    { name: "Yogurt", item: "blooks/Yogurt.webp", type: "uncommon", weight: 20 },
    { name: "Breakfast Combo", item: "blooks/Breakfast Combo.webp", type: "uncommon", weight: 20 },
    { name: "Orange Juice", item: "blooks/Orange Juice.webp", type: "uncommon", weight: 20 },
    { name: "Milk", item: "blooks/Milk.webp", type: "uncommon", weight: 20 },
    { name: "Waffle", item: "blooks/Waffle.webp", type: "rare", weight: 20 },
    { name: "Pancakes", item: "blooks/Pancakes.webp", type: "rare", weight: 20 },
    { name: "French Toast", item: "blooks/French Toast.webp", type: "epic", weight: 12 },
    { name: "Pizza", item: "blooks/Pizza.webp", type: "epic", weight: 12 },
    { name: "Chocolate Milk", item: "blooks/Chocolate Milk.webp", type: "legendary", weight: 5 },
    { name: "Bacon and Eggs", item: "blooks/Bacon and Eggs.webp", type: "chroma", weight: 0.0945},
    { name: "Rainbow Waffles", item: "blooks/Rainbow Waffles.webp", type: "mystical", weight: 0.00189 }
  ] },
  outbackpack: { label: "Outback Pack", cost: 50, rates: [
    { name: "Dingo", item: "blooks/Dingo.webp", type: "uncommon", weight: 20 },
    { name: "Echidna", item: "blooks/Echidna.webp", type: "uncommon", weight: 20 },
    { name: "Koala", item: "blooks/Koala.webp", type: "uncommon", weight: 20 },
    { name: "Kookaburra", item: "blooks/Kookaburra.webp", type: "uncommon", weight: 20 },
    { name: "Joey", item: "blooks/Joey.webp", type: "rare", weight: 15 },
    { name: "Kangaroo", item: "blooks/Kangaroo.webp", type: "rare", weight: 15 },
    { name: "Platypus", item: "blooks/Platypus.webp", type: "rare", weight: 15 },
    { name: "Crocodile", item: "blooks/Crocodile.webp", type: "epic", weight: 24 },
    { name: "Sugar Glider", item: "blooks/SugarGlider.webp", type: "legendary", weight: 5 },
    { name: "Teal Platypus", item: "blooks/TealPlatypus.webp", type: "chroma", weight: 0.077 }
  ] },
  safariPack: { label: "Safari Pack", cost: 50, rates: [
    { name: "Panda", item: "blooks/Panda.webp", type: "uncommon", weight: 20 },
    { name: "Sloth", item: "blooks/Sloth.webp", type: "uncommon", weight: 20 },
    { name: "Tenrec", item: "blooks/Tenrec.webp", type: "uncommon", weight: 20 },
    { name: "Flamingo", item: "blooks/Flamingo.webp", type: "uncommon", weight: 20 },
    { name: "Zebra", item: "blooks/Zebra.webp", type: "uncommon", weight: 20 },
    { name: "Elephant", item: "blooks/Elephant.webp", type: "rare", weight: 15 },
    { name: "Lemur", item: "blooks/Lemur.webp", type: "rare", weight: 15 },
    { name: "Peacock", item: "blooks/Peacock.webp", type: "rare", weight: 15 },
    { name: "Chameleon", item: "blooks/Chameleon.webp", type: "epic", weight: 24 },
    { name: "Lion", item: "blooks/Lion.webp", type: "legendary", weight: 5 },
    { name: "Rainbow Panda", item: "blooks/Rainbow Panda.webp", type: "chroma", weight: 0.087 }
  ] },
  bugPack: { label: "Bug Pack", cost: 50, rates: [
    { name: "Ant", item: "blooks/Ant.webp", type: "uncommon", weight: 20 },
    { name: "Rhino Beetle", item: "blooks/Rhino Beetle.webp", type: "uncommon", weight: 20 },
    { name: "Ladybug", item: "blooks/Ladybug.webp", type: "uncommon", weight: 20 },
    { name: "Fly", item: "blooks/Fly.webp", type: "uncommon", weight: 20 },
    { name: "Worm", item: "blooks/Worm.webp", type: "rare", weight: 15 },
    { name: "Bee", item: "blooks/Bee.webp", type: "rare", weight: 15 },
    { name: "Mantis", item: "blooks/Mantis.webp", type: "epic", weight: 24 },
    { name: "Butterfly", item: "blooks/Butterfly.webp", type: "legendary", weight: 5 },
    { name: "Blue Butterfly", item: "blooks/Blue Butterfly.webp", type: "chroma", weight: 0.0695}
  ] },
  iceMonstersPack: { label: "Ice Monsters Pack", cost: 50, rates: [
    { name: "Ice Bat", item: "blooks/Ice Bat.webp", type: "uncommon", weight: 20 },
    { name: "Ice Bug", item: "blooks/Ice Bug.webp", type: "uncommon", weight: 20 },
    { name: "Ice Elemental", item: "blooks/Ice Elemental.webp", type: "uncommon", weight: 20 },
    { name: "Rock Monster", item: "blooks/Rock Monster.webp", type: "uncommon", weight: 20 },
    { name: "Dink", item: "blooks/Dink.webp", type: "rare", weight: 15 },
    { name: "Donk", item: "blooks/Donk.webp", type: "rare", weight: 15 },
    { name: "Bush Monsters", item: "blooks/Bush Monsters.webp", type: "epic", weight: 24 },
    { name: "Yeti", item: "blooks/Yeti.webp", type: "legendary", weight: 5 },
    { name: "Ice Slime", item: "blooks/Ice Slime.webp", type: "chroma", weight: 0.0695 },
    { name: "Frozen Fossil", item: "blooks/Frozen Fossil.webp", type: "chroma", weight: 0.0695 },
    { name: "Ice Crab", item: "blooks/Ice Crab.webp", type: "chroma", weight: 0.0695 }
  ] },
  aquaticPack: { label: "Aquatic Pack", cost: 50, rates: [
    { name: "Old Boot", item: "blooks/Old Boot.webp", type: "uncommon", weight: 20 },
    { name: "Clownfish", item: "blooks/Clownfish.webp", type: "uncommon", weight: 20 },
    { name: "Crab", item: "blooks/Crab.webp", type: "uncommon", weight: 20 },
    { name: "Frog", item: "blooks/Frog.webp", type: "uncommon", weight: 20 },
    { name: "Jellyfish", item: "blooks/Jellyfish.webp", type: "uncommon", weight: 20 },
    { name: "Blobfish", item: "blooks/Blobfish.webp", type: "rare", weight: 15 },
    { name: "Octopus", item: "blooks/Octopus.webp", type: "rare", weight: 15 },
    { name: "Pufferfish", item: "blooks/Pufferfish.webp", type: "rare", weight: 15 },
    { name: "Narwal", item: "blooks/Narwal.webp", type: "epic", weight: 12 },
    { name: "Dolphin", item: "blooks/Dolphin.webp", type: "epic", weight: 12 },
    { name: "Baby Shark", item: "blooks/Baby Shark.webp", type: "legendary", weight: 2.5 },
    { name: "Megalodon", item: "blooks/Megalodon.webp", type: "legendary", weight: 2.5 },
    { name: "Golden Blobfish", item: "blooks/Golden Blobfish.webp", type: "chroma", weight: 0.087 }
  ] },
  eventPack: {
    label: "Ruby Shop", cost: 0, disabled: true,
    get rates() {
      return db.eventItems.map(i => ({ name: i.name, item: i.image, type: i.rarity, weight: 1 }));
    }
  }
};
const RARITY_SELL = { common: 15, uncommon: 30, rare: 60, epic: 150, legendary: 500, chroma: 1500, mystical: 5000, supreme: 20000 };

const BOOSTER_DURATION_MS = 2 * 60 * 60 * 1000;
const BOOSTER_OPTIONS = {
  x2: { multiplier: 2, cost: 5000 },
  x3: { multiplier: 3, cost: 10000 }
};

const CLAN_CREATE_COST = 1000;
const CLAN_COLORS = {
  gray:    { label: "Gray",    hex: "#aaaaaa", cost: 0 },
  red:     { label: "Red",     hex: "#ff4444", cost: 500 },
  orange:  { label: "Orange",  hex: "#ff9f43", cost: 1000 },
  yellow:  { label: "Yellow",  hex: "#ffd93d", cost: 1500 },
  green:   { label: "Green",   hex: "#26da72", cost: 2000 },
  blue:    { label: "Blue",    hex: "#3b82f6", cost: 3000 },
  purple:  { label: "Purple",  hex: "#a855f7", cost: 5000 },
  pink:    { label: "Pink",    hex: "#ff6bcb", cost: 7500 },
  rainbow: { label: "Rainbow", hex: "linear-gradient(90deg,#ff4444,#ff9f43,#ffd93d,#26da72,#3b82f6,#a855f7,#ff6bcb)", cost: 15000 }
};
const CLAN_BANK_LEVELS = [5000, 100000, 1000000, 10000000, 500000000];
const HOURLY_DEPOSIT_LIMIT = 1000000;
const BANK_BONUS_MIN_CONTRIBUTORS = 3;
const BANK_BONUS_MIN_SHARE = 0.10;
const COMPETITION_CYCLE_MS = 14 * 24 * 60 * 60 * 1000;
const COMPETITION_CLAN_REWARD_PER_MEMBER = 50000;
const COMPETITION_INDIVIDUAL_REWARD = 250000;

const BADGE_CATALOG = [
  { id: 'owner',       label: 'Owner',       icon: '👑', image: 'badges/owner.png',       check: u => !!u.isOwner },
  { id: 'co-owner',    label: 'Co-Owner',    icon: '👑', image: 'badges/co-owner.png',    check: u => (u.grantedBadges || []).includes('co-owner') },
  { id: 'admin',       label: 'Admin',       icon: '🛡️', image: 'badges/admin.png',       check: u => !!u.isAdmin },
  { id: 'dev',         label: 'Developer',   icon: '💻', image: 'badges/dev.png',         check: u => (u.grantedBadges || []).includes('dev') },
  { id: 'artist',      label: 'Artist',      icon: '🎨', image: 'badges/artist.png',      check: u => (u.grantedBadges || []).includes('artist') },
  { id: 'mod',         label: 'Mod',         icon: '🔨', image: 'badges/mod.png',         check: u => (u.grantedBadges || []).includes('mod') },
  { id: 'og',          label: 'OG',          icon: '💎', image: 'badges/og.png',          check: u => (u.grantedBadges || []).includes('og') },
  { id: 'pack_master', label: 'Pack Master', icon: '📦', image: 'badges/pack_master.png', check: u => (u.packsOpened || 0) >= 100 },
  { id: 'chatterbox',  label: 'Chatterbox',  icon: '💬', image: 'badges/chatterbox.png',  check: u => (u.messagesSent || 0) >= 100 },
  { id: 'collector',   label: 'Collector',   icon: '🏆', image: 'badges/collector.png',   check: u => Object.values(u.collection || {}).filter(q => q > 0).length >= 21 }
];

function badgesEarnedBy(user) {
  return BADGE_CATALOG.filter(b => b.check(user));
}
function equippedBadgeInfo(user) {
  if (!user.equippedBadge) return null;
  const badge = BADGE_CATALOG.find(b => b.id === user.equippedBadge);
  if (!badge || !badge.check(user)) return null;
  return { id: badge.id, label: badge.label, icon: badge.icon, image: badge.image };
}

function clanTagInfo(user) {
  if (!user.clanId || !db.clans[user.clanId]) return null;
  const clan = db.clans[user.clanId];
  const colorInfo = CLAN_COLORS[clan.activeColor];
  const hex = (colorInfo && !colorInfo.hex.startsWith('linear')) ? colorInfo.hex : '#ff6bcb';
  return { tag: clan.name, color: hex };
}

function chatIdentityFor(username) {
  const user = getUser(username);
  if (!user) return { avatar: null, badge: null, clan: null };
  return {
    avatar: user.avatar || null,
    badge: equippedBadgeInfo(user),
    clan: clanTagInfo(user)
  };
}

const MAX_IPS_PER_USER = 10;
if (!db.meta.ipSalt) db.meta.ipSalt = crypto.randomBytes(32).toString('hex');

function hashIP(ip) {
  if (!ip) return null;
  const normalized = String(ip).replace(/^::ffff:/, '');
  return crypto.createHmac('sha256', db.meta.ipSalt).update(normalized).digest('hex').slice(0, 16);
}
function requestIP(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || null;
}
function socketIP(socket) {
  const xff = socket.handshake.headers['x-forwarded-for'];
  if (xff) return xff.split(',').pop().trim();
  return socket.handshake.address;
}
function isIPBanned(ipHash) {
  return !!(ipHash && own(db.ipBans, ipHash));
}
function rememberIP(user, ipHash) {
  if (!ipHash) return false;
  if (user.ipHashes[0] === ipHash) return false;
  const isNew = !user.ipHashes.includes(ipHash);
  user.ipHashes = [ipHash, ...user.ipHashes.filter(h => h !== ipHash)].slice(0, MAX_IPS_PER_USER);
  return isNew;
}
function linkedAccounts(user) {
  const mine = new Set(user.ipHashes);
  if (mine.size === 0) return [];
  return Object.values(db.users).filter(u => u !== user && u.ipHashes.some(h => mine.has(h)));
}
function isStaff(user) {
  return !!(user && (user.isAdmin || user.isOwner));
}
function canModerate(actor, target) {
  if (target.isOwner) return false;
  if (target.isAdmin && !actor.isOwner) return false;
  return actor !== target;
}
function banIPsOf(user, bannedBy) {
  let count = 0;
  user.ipHashes.forEach(h => {
    if (!own(db.ipBans, h)) {
      db.ipBans[h] = { player: user.username, bannedBy, at: Date.now() };
      count++;
    }
  });
  return count;
}

function getUser(username) {
  if (!username || typeof username !== 'string') return null;
  return own(db.users, username.toLowerCase()) || null;
}
function createUser(username, passwordHash) {
  const key = username.toLowerCase();
  const isOwner = OWNER_USERNAMES.includes(key);
  db.users[key] = {
    username,
    passwordHash,
    tokens: STARTING_TOKENS,
    collection: {},
    isAdmin: isOwner,
    isOwner,
    muted: false,
    banned: { active: false },
    ipHashes: [],
    createdAt: Date.now(),
    clanId: null,
    hourlyDeposit: { amount: 0, windowStart: 0 },
    booster: null,
    theme: 'orange',
    avatar: null,
    packsOpened: 0,
    messagesSent: 0,
    friends: [],
    incomingRequests: [],
    outgoingRequests: [],
    equippedBadge: null,
    lastDailySpinAt: null,
    rubies: 0,
    grantedBadges: []
  };
  saveDB();
  return db.users[key];
}
function clearExpiredBooster(user) {
  if (user.booster && Date.now() >= user.booster.expiresAt) {
    user.booster = null;
  }
}
function publicUser(u) {
  clearExpiredBooster(u);
  return {
    username: u.username,
    tokens: u.tokens,
    collection: u.collection,
    isAdmin: u.isAdmin,
    isOwner: !!u.isOwner,
    muted: u.muted,
    banned: u.banned,
    clanId: u.clanId,
    booster: u.booster,
    theme: u.theme || 'orange',
    avatar: u.avatar || null,
    packsOpened: u.packsOpened || 0,
    messagesSent: u.messagesSent || 0,
    rubies: u.rubies || 0
  };
}

const WIPE_KEEP_USERNAMES = ['Aaron', 'AyAyRon'];

function wipeDataOnce(marker) {
  if (!marker || db.meta.lastWipe === marker) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(DATA_DIR, `manglet-before-wipe-${stamp}.sqlite`);
  saveDB();
  store.backup(backupPath);

  const before = Object.keys(db.users).length;
  Object.keys(db.users).forEach(key => {
    if (!WIPE_KEEP_USERNAMES.includes(key)) delete db.users[key];
  });
  const kept = Object.keys(db.users);
  Object.values(db.users).forEach(u => {
    u.tokens = 0;
    u.rubies = 0;
    u.collection = {};
    u.packsOpened = 0;
    u.messagesSent = 0;
    u.booster = null;
    u.lastDailySpinAt = null;
    u.hourlyDeposit = { amount: 0, windowStart: 0 };
    if (u.avatar && u.avatar.startsWith('blooks/')) u.avatar = null;
    u.clanId = null;
    u.friends = u.friends.filter(k => kept.includes(k));
    u.incomingRequests = u.incomingRequests.filter(k => kept.includes(k));
    u.outgoingRequests = u.outgoingRequests.filter(k => kept.includes(k));
  });

  db.clans = {};
  db.trades = [];
  db.listings = [];
  db.globalChat = [];
  db.news = [];
  db.reports = [];
  db.sessions = {};
  db.competition = defaultDB().competition;
  db.meta.lastWipe = marker;
  saveDB();

  try {
    fs.readdirSync(UPLOAD_DIR).forEach(name => removeUploadIfUnused(UPLOAD_URL_PREFIX + name));
  } catch (e) {}

  console.log('removed ' + before - kept.length + ' accounts');
}
wipeDataOnce(process.env.WIPE_DATA);

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
Object.keys(db.sessions).forEach(t => {
  const s = db.sessions[t];
  if (!s || typeof s !== 'object' || Date.now() - s.createdAt > SESSION_TTL_MS) delete db.sessions[t];
});
const sessions = new Map(Object.entries(db.sessions));

function setSession(token, key) {
  const entry = { user: key, createdAt: Date.now() };
  sessions.set(token, entry);
  db.sessions[token] = entry;
  saveDB();
}
function deleteSession(token) {
  sessions.delete(token);
  delete db.sessions[token];
}

function userKeyForToken(token) {
  if (typeof token !== 'string') return null;
  const entry = sessions.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > SESSION_TTL_MS) { deleteSession(token); return null; }
  const user = own(db.users, entry.user);
  if (!user || isBanned(user)) return null;
  return entry.user;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const key = userKeyForToken(token);
  if (!key) {
    return res.status(401).json({ message: 'Not logged in.' });
  }
  const user = db.users[key];
  const ipHash = hashIP(requestIP(req));
  if (isIPBanned(ipHash) && !isStaff(user)) {
    return res.status(403).json({ message: 'This network is banned.' });
  }
  if (rememberIP(user, ipHash)) saveDB();
  req.username = key;
  next();
}
function requireAdmin(req, res, next) {
  const user = db.users[req.username];
  if (!user || (!user.isAdmin && !user.isOwner)) {
    return res.status(403).json({ message: 'Admin access required.' });
  }
  next();
}
function requireOwner(req, res, next) {
  const user = db.users[req.username];
  if (!user || !user.isOwner) {
    return res.status(403).json({ message: 'Owner access required.' });
  }
  next();
}

app.post('/api/signup', signupRateLimit, async (req, res) => {
  const { username, password, setupCode } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }
  if (!USERNAME_RE.test(username) || FORBIDDEN_KEYS.includes(username.toLowerCase())) {
    return res.status(400).json({ message: 'Usernames must be 3-20 characters: letters, numbers and underscores only.' });
  }
  if (password.length < 6 || password.length > 72) {
    return res.status(400).json({ message: 'Passwords must be 6-72 characters.' });
  }

  const key = username.toLowerCase();
  const ipHash = hashIP(requestIP(req));
  if (isIPBanned(ipHash)) return res.status(403).json({ message: 'This network is banned.' });
  if (own(db.users, key)) return res.status(409).json({ message: 'That username is already taken.' });

  if (RESERVED_USERNAMES.includes(key)) {
    if (!OWNER_SETUP_CODE || setupCode !== OWNER_SETUP_CODE) {
      return res.status(403).json({ message: 'This username is reserved.' });
    }
  }

  const passwordHash = await bcrypt.hash(password, 10);
  if (own(db.users, key)) return res.status(409).json({ message: 'That username is already taken.' });
  const user = createUser(username, passwordHash);
  rememberIP(user, ipHash);

  const token = crypto.randomBytes(24).toString('hex');
  setSession(token, key);

  res.json({ message: 'Account created.', token, user: publicUser(user) });
});

app.post('/api/login', loginRateLimit, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  const key = username.toLowerCase();
  const user = own(db.users, key);
  if (!user) return res.status(401).json({ message: 'Invalid username or password.' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ message: 'Invalid username or password.' });

  if (isBanned(user)) return res.status(403).json({ message: 'This account is banned.' });
  const ipHash = hashIP(requestIP(req));
  if (isIPBanned(ipHash) && !isStaff(user)) return res.status(403).json({ message: 'This network is banned.' });
  rememberIP(user, ipHash);

  user.isAdmin = user.isAdmin || OWNER_USERNAMES.includes(key);
  user.isOwner = user.isOwner || OWNER_USERNAMES.includes(key);
  if (user.isOwner) user.isAdmin = true;

  const token = crypto.randomBytes(24).toString('hex');
  setSession(token, key);

  res.json({ message: 'Logged in.', token, user: publicUser(user) });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(db.users[req.username]) });
});

const VALID_THEMES = ['orange', 'black'];
app.post('/api/settings/theme', requireAuth, (req, res) => {
  const { theme } = req.body || {};
  if (!VALID_THEMES.includes(theme)) return res.status(400).json({ message: 'Unknown theme.' });

  const user = db.users[req.username];
  user.theme = theme;
  saveDB();
  res.json({ theme: user.theme });
});

app.get('/uploads/:name', (req, res) => {
  const name = req.params.name;
  if (!UPLOAD_NAME_RE.test(name)) return res.status(404).end();
  res.set({
    'Content-Type': UPLOAD_MIME[name.split('.').pop()],
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    'Cache-Control': 'public, max-age=31536000, immutable'
  });
  res.sendFile(path.join(UPLOAD_DIR, name), err => { if (err && !res.headersSent) res.status(404).end(); });
});
const readImageBody = express.raw({ type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], limit: UPLOAD_MAX_BYTES });
const uploadRateLimit = rateLimit(10 * 60 * 1000, 10, 'Too many uploads — please wait a few minutes.');
function imageUpload(req, res, next) {
  readImageBody(req, res, err => {
    if (err) return res.status(err.type === 'entity.too.large' ? 413 : 400).json({ message: 'Images must be 512 KB or smaller.' });
    if (!Buffer.isBuffer(req.body) || !detectImageExt(req.body)) {
      return res.status(400).json({ message: 'Upload a PNG, JPG, GIF, or WebP image.' });
    }
    next();
  });
}

function setAvatar(user, image) {
  const old = user.avatar;
  user.avatar = image;
  saveDB();
  removeUploadIfUnused(old);
  io.emit('identityUpdate', { username: user.username, ...chatIdentityFor(user.username) });
}

app.post('/api/settings/avatar', requireAuth, (req, res) => {
  const { image } = req.body || {};
  if (String(image || '').trim()) return res.status(400).json({ message: 'Upload an image file instead of a link.' });
  const user = db.users[req.username];
  setAvatar(user, null);
  res.json({ avatar: user.avatar });
});

app.post('/api/settings/avatar/upload', requireAuth, uploadRateLimit, imageUpload, (req, res) => {
  const user = db.users[req.username];
  setAvatar(user, saveUpload(req.body));
  res.json({ avatar: user.avatar });
});

app.post('/api/settings/avatar/blook', requireAuth, (req, res) => {
  const { packKey, name } = req.body || {};
  const pack = own(PACK_CONFIGS, packKey);
  const blook = pack && pack.rates.find(r => r.name === name);
  if (!blook) return res.status(400).json({ message: 'Unknown blook.' });

  const user = db.users[req.username];
  const owned = user.collection[packKey + '::' + name] || 0;
  if (owned < 1) return res.status(400).json({ message: "You don't own that blook." });

  setAvatar(user, blook.item);
  res.json({ avatar: user.avatar });
});

app.get('/api/badges', requireAuth, (req, res) => {
  const user = db.users[req.username];
  const earnedIds = badgesEarnedBy(user).map(b => b.id);
  res.json({
    catalog: BADGE_CATALOG.map(b => ({ id: b.id, label: b.label, icon: b.icon, image: b.image })),
    earned: earnedIds,
    equipped: user.equippedBadge || null
  });
});

app.post('/api/settings/badge', requireAuth, (req, res) => {
  const { badgeId } = req.body || {};
  const user = db.users[req.username];

  if (!badgeId) {
    user.equippedBadge = null;
    saveDB();
    io.emit('identityUpdate', { username: user.username, ...chatIdentityFor(user.username) });
    return res.json({ equipped: null });
  }

  const badge = BADGE_CATALOG.find(b => b.id === badgeId);
  if (!badge) return res.status(400).json({ message: 'Unknown badge.' });
  if (!badge.check(user)) return res.status(400).json({ message: "You haven't earned that badge yet." });

  user.equippedBadge = badgeId;
  saveDB();
  io.emit('identityUpdate', { username: user.username, ...chatIdentityFor(user.username) });
  res.json({ equipped: user.equippedBadge });
});

app.get('/api/profile/:username', requireAuth, (req, res) => {
  const user = getUser(req.params.username);
  if (!user) return res.status(404).json({ message: 'No such player.' });
  res.json({ user: publicUser(user) });
});

const RESERVED_BADGE_IDS = ['owner', 'admin', 'gamer', 'plus', 'pack_master', 'chatterbox', 'collector'];

app.post('/api/owner/grant-badge', requireAuth, requireOwner, (req, res) => {
  const { username, badgeId } = req.body || {};
  const user = getUser(username);
  if (!user) return res.status(404).json({ message: 'No such player.' });

  const badge = BADGE_CATALOG.find(b => b.id === badgeId);
  if (!badge) return res.status(400).json({ message: 'Unknown badge.' });
  if (RESERVED_BADGE_IDS.includes(badgeId)) {
    return res.status(400).json({ message: `"${badge.label}" isn't a manually-grantable badge.` });
  }

  user.grantedBadges = user.grantedBadges || [];
  if (!user.grantedBadges.includes(badgeId)) user.grantedBadges.push(badgeId);
  saveDB();
  res.json({ message: `${user.username} now has the ${badge.label} badge.` });
});

app.post('/api/owner/revoke-badge', requireAuth, requireOwner, (req, res) => {
  const { username, badgeId } = req.body || {};
  const user = getUser(username);
  if (!user) return res.status(404).json({ message: 'No such player.' });

  const badge = BADGE_CATALOG.find(b => b.id === badgeId);
  if (!badge) return res.status(400).json({ message: 'Unknown badge.' });

  user.grantedBadges = (user.grantedBadges || []).filter(id => id !== badgeId);
  saveDB();
  res.json({ message: `${user.username} no longer has the ${badge.label} badge.` });
});

const DAILY_WHEEL_SEGMENTS = [1000, 1200, 1300, 1400, 1600, 1700, 1800, 2000];
const DAILY_WHEEL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

app.get('/api/daily-wheel/status', requireAuth, (req, res) => {
  const user = db.users[req.username];
  const last = user.lastDailySpinAt || 0;
  const elapsed = Date.now() - last;
  const canSpin = elapsed >= DAILY_WHEEL_COOLDOWN_MS;
  res.json({
    canSpin,
    msRemaining: canSpin ? 0 : DAILY_WHEEL_COOLDOWN_MS - elapsed,
    segments: DAILY_WHEEL_SEGMENTS
  });
});

app.post('/api/daily-wheel/spin', requireAuth, (req, res) => {
  const user = db.users[req.username];
  const last = user.lastDailySpinAt || 0;
  const elapsed = Date.now() - last;
  if (elapsed < DAILY_WHEEL_COOLDOWN_MS) {
    return res.status(400).json({ message: 'You already spun today — come back later.', msRemaining: DAILY_WHEEL_COOLDOWN_MS - elapsed });
  }

  const index = Math.floor(Math.random() * DAILY_WHEEL_SEGMENTS.length);
  const reward = DAILY_WHEEL_SEGMENTS[index];
  user.tokens += reward;
  user.lastDailySpinAt = Date.now();
  saveDB();

  res.json({ index, reward, tokens: user.tokens });
});

function isEventItemPurchasable(item) {
  if (!item.active) return false;
  if (item.endsAt && Date.now() > item.endsAt) return false;
  return true;
}

app.get('/api/rubyshop/items', requireAuth, (req, res) => {
  const items = db.eventItems.filter(isEventItemPurchasable).map(i => ({
    id: i.id, name: i.name, image: i.image, rarity: i.rarity, cost: i.cost, endsAt: i.endsAt
  }));
  res.json({ items });
});

app.post('/api/rubyshop/buy', requireAuth, (req, res) => {
  const { itemId } = req.body || {};
  const item = db.eventItems.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ message: 'Item not found.' });
  if (!isEventItemPurchasable(item)) return res.status(400).json({ message: 'This item is no longer available.' });

  const user = db.users[req.username];
  if (!canAfford(user.rubies, item.cost)) return res.status(400).json({ message: "You don't have enough rubies." });

  user.rubies -= item.cost;
  const key = 'eventPack::' + item.name;
  user.collection[key] = (user.collection[key] || 0) + 1;
  saveDB();

  res.json({ rubies: user.rubies, item: blookDisplay(key, user.collection[key]) });
});

app.get('/api/admin/rubyshop/items', requireAuth, requireAdmin, (req, res) => {
  res.json({ items: db.eventItems });
});

app.post('/api/admin/rubyshop/items', requireAuth, requireAdmin, (req, res) => {
  const { name, image, rarity, cost, endsAt } = req.body || {};
  if (!name || !image || !rarity || !cost) return res.status(400).json({ message: 'Name, image, rarity, and cost are all required.' });
  if (!own(RARITY_SELL, rarity)) return res.status(400).json({ message: 'Unknown rarity.' });
  if (db.eventItems.some(i => i.name.toLowerCase() === String(name).toLowerCase() && i.active)) {
    return res.status(409).json({ message: 'An active item with that name already exists.' });
  }

  const item = {
    id: crypto.randomBytes(6).toString('hex'),
    name: String(name).trim(),
    image: String(image).trim(),
    rarity,
    cost: Math.max(1, Math.floor(Number(cost)) || 1),
    active: true,
    endsAt: endsAt ? Number(endsAt) : null,
    createdAt: Date.now()
  };
  db.eventItems.push(item);
  saveDB();
  res.json({ item });
});

app.post('/api/admin/rubyshop/items/:id/toggle', requireAuth, requireAdmin, (req, res) => {
  const item = db.eventItems.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ message: 'Item not found.' });
  item.active = !item.active;
  saveDB();
  res.json({ item });
});

app.get('/api/leaderboard', requireAuth, (req, res) => {
  const sort = req.query.sort === 'packs' ? 'packs' : 'coins';
  const rows = Object.values(db.users)
    .map(u => ({
      username: u.username,
      avatar: u.avatar || null,
      tokens: u.tokens,
      packsOpened: u.packsOpened || 0,
      isOwner: !!u.isOwner,
      isAdmin: !!u.isAdmin,
      badge: equippedBadgeInfo(u)
    }))
    .sort((a, b) => sort === 'packs' ? b.packsOpened - a.packsOpened : b.tokens - a.tokens)
    .slice(0, 50);
  res.json({ sort, rows });
});

function publicFriendInfo(u) {
  return {
    username: u.username,
    avatar: u.avatar || null,
    isOwner: !!u.isOwner,
    isAdmin: !!u.isAdmin,
    ownedGamer: !!u.ownedGamer,
    ownedPlus: !!u.ownedPlus
  };
}

app.get('/api/friends', requireAuth, (req, res) => {
  const user = db.users[req.username];
  const friends = (user.friends || []).map(k => db.users[k]).filter(Boolean).map(publicFriendInfo);
  const incoming = (user.incomingRequests || []).map(k => db.users[k]).filter(Boolean).map(publicFriendInfo);
  const outgoing = (user.outgoingRequests || []).map(k => db.users[k]).filter(Boolean).map(publicFriendInfo);
  res.json({ friends, incoming, outgoing });
});

app.post('/api/friends/request', requireAuth, (req, res) => {
  const target = getUser((req.body || {}).username);
  if (!target) return res.status(404).json({ message: 'No such player.' });
  const targetKey = target.username.toLowerCase();
  if (targetKey === req.username) return res.status(400).json({ message: "You can't friend yourself." });

  const user = db.users[req.username];
  if (user.friends.includes(targetKey)) return res.status(400).json({ message: 'Already friends.' });
  if (user.outgoingRequests.includes(targetKey)) return res.status(400).json({ message: 'Request already sent.' });
  if (user.incomingRequests.includes(targetKey)) return res.status(400).json({ message: 'They already sent you a request — check your Requests tab.' });

  user.outgoingRequests.push(targetKey);
  target.incomingRequests.push(req.username);
  saveDB();
  res.json({ message: 'Friend request sent.' });
});

app.post('/api/friends/accept', requireAuth, (req, res) => {
  const target = getUser((req.body || {}).username);
  if (!target) return res.status(404).json({ message: 'No such player.' });
  const targetKey = target.username.toLowerCase();
  const user = db.users[req.username];

  if (!user.incomingRequests.includes(targetKey)) return res.status(400).json({ message: 'No pending request from that player.' });

  user.incomingRequests = user.incomingRequests.filter(k => k !== targetKey);
  target.outgoingRequests = target.outgoingRequests.filter(k => k !== req.username);

  if (!user.friends.includes(targetKey)) user.friends.push(targetKey);
  if (!target.friends.includes(req.username)) target.friends.push(req.username);

  saveDB();
  res.json({ message: `You're now friends with ${target.username}.` });
});

app.post('/api/friends/decline', requireAuth, (req, res) => {
  const target = getUser((req.body || {}).username);
  if (!target) return res.status(404).json({ message: 'No such player.' });
  const targetKey = target.username.toLowerCase();
  const user = db.users[req.username];

  user.incomingRequests = user.incomingRequests.filter(k => k !== targetKey);
  target.outgoingRequests = target.outgoingRequests.filter(k => k !== req.username);
  saveDB();
  res.json({ message: 'Request declined.' });
});

app.post('/api/friends/cancel', requireAuth, (req, res) => {
  const target = getUser((req.body || {}).username);
  if (!target) return res.status(404).json({ message: 'No such player.' });
  const targetKey = target.username.toLowerCase();
  const user = db.users[req.username];

  user.outgoingRequests = user.outgoingRequests.filter(k => k !== targetKey);
  target.incomingRequests = target.incomingRequests.filter(k => k !== req.username);
  saveDB();
  res.json({ message: 'Request cancelled.' });
});

app.post('/api/friends/remove', requireAuth, (req, res) => {
  const target = getUser((req.body || {}).username);
  if (!target) return res.status(404).json({ message: 'No such player.' });
  const targetKey = target.username.toLowerCase();
  const user = db.users[req.username];

  user.friends = user.friends.filter(k => k !== targetKey);
  target.friends = target.friends.filter(k => k !== req.username);
  saveDB();
  res.json({ message: `Removed ${target.username} from your friends.` });
});

app.get('/api/packs', (req, res) => {
  res.json({ packs: PACK_CONFIGS, sellValues: RARITY_SELL });
});

function pickWeighted(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of items) {
    if (roll < item.weight) return item;
    roll -= item.weight;
  }
  return items[items.length - 1];
}

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'chroma', 'mystical', 'supreme'];
const BOOST_FLOOR_INDEX = RARITY_ORDER.indexOf('rare');

function boostedItems(pack, multiplier) {
  if (!multiplier || multiplier <= 1) return pack.rates;
  return pack.rates.map(item => {
    const rank = RARITY_ORDER.indexOf(item.type);
    const shouldBoost = rank >= BOOST_FLOOR_INDEX;
    return { ...item, weight: shouldBoost ? item.weight * multiplier : item.weight };
  });
}

app.post('/api/packs/open', requireAuth, (req, res) => {
  const { packKey } = req.body || {};
  const pack = own(PACK_CONFIGS, packKey);
  if (!pack) return res.status(400).json({ message: 'Unknown pack.' });
  if (pack.disabled) return res.status(400).json({ message: 'This pack is currently unavailable.' });

  const user = db.users[req.username];
  if (!canAfford(user.tokens, pack.cost)) return res.status(400).json({ message: 'Not enough coins.' });

  clearExpiredBooster(user);
  user.tokens -= pack.cost;

  const items = boostedItems(pack, user.booster ? user.booster.multiplier : null);
  const tier = pickWeighted(items);

  const key = packKey + '::' + tier.name;
  user.collection[key] = (user.collection[key] || 0) + 1;
  user.packsOpened = (user.packsOpened || 0) + 1;

  maybeRolloverCompetition();
  awardCompetitionPoint(user, 1);

  saveDB();

  res.json({ tokens: user.tokens, reward: tier });
});

app.post('/api/collection/sell', requireAuth, (req, res) => {
  const { packKey, name, qty } = req.body || {};
  const pack = own(PACK_CONFIGS, packKey);
  const blook = pack && pack.rates.find(r => r.name === name);
  if (!blook) return res.status(400).json({ message: 'Unknown blook.' });

  const user = db.users[req.username];
  const key = packKey + '::' + name;
  const owned = user.collection[key] || 0;
  const amount = Math.max(1, parseInt(qty, 10) || 1);
  if (amount > owned) return res.status(400).json({ message: "You don't own that many." });

  user.collection[key] = owned - amount;
  if (user.collection[key] <= 0) delete user.collection[key];
  user.tokens += RARITY_SELL[blook.type] * amount;
  saveDB();

  res.json({ tokens: user.tokens, collection: user.collection });
});

app.post('/api/collection/sell-duplicates', requireAuth, (req, res) => {
  const user = db.users[req.username];
  let gained = 0;

  Object.entries(PACK_CONFIGS).forEach(([packKey, cfg]) => {
    cfg.rates.forEach(b => {
      const key = packKey + '::' + b.name;
      const owned = user.collection[key] || 0;
      if (owned > 1) {
        gained += (owned - 1) * RARITY_SELL[b.type];
        user.collection[key] = 1;
      }
    });
  });

  user.tokens += gained;
  saveDB();
  res.json({ tokens: user.tokens, collection: user.collection, gained });
});

app.get('/api/boosters', requireAuth, (req, res) => {
  res.json({ options: BOOSTER_OPTIONS, durationMs: BOOSTER_DURATION_MS });
});

app.post('/api/boosters/buy', requireAuth, (req, res) => {
  const { tier } = req.body || {};
  const option = own(BOOSTER_OPTIONS, tier);
  if (!option) return res.status(400).json({ message: 'Unknown booster.' });

  const user = db.users[req.username];
  clearExpiredBooster(user);
  if (user.booster) return res.status(400).json({ message: 'You already have a booster active.' });
  if (!canAfford(user.tokens, option.cost)) return res.status(400).json({ message: 'Not enough tokens.' });

  user.tokens -= option.cost;
  const now = Date.now();
  user.booster = { multiplier: option.multiplier, activatedAt: now, expiresAt: now + BOOSTER_DURATION_MS };
  saveDB();

  res.json({ tokens: user.tokens, booster: user.booster });
});

app.post('/api/boosters/cancel', requireAuth, (req, res) => {
  const user = db.users[req.username];
  clearExpiredBooster(user);
  if (!user.booster) return res.status(400).json({ message: 'No active booster.' });

  user.booster = null;
  saveDB();
  res.json({ message: 'Booster disabled.' });
});

function getClan(clanId) {
  return own(db.clans, clanId) || null;
}
function userClan(user) {
  return getClan(user.clanId);
}
function clanMemberList(clan) {
  const entries = Object.entries(clan.roles).map(([key, role]) => ({
    username: db.users[key] ? db.users[key].username : key,
    role
  }));
  const order = { owner: 0, admin: 1, member: 2 };
  return entries.sort((a, b) => order[a.role] - order[b.role] || a.username.localeCompare(b.username));
}
function publicClan(clan, viewerKey) {
  const result = {
    id: clan.id,
    name: clan.name,
    tag: clan.tag,
    description: clan.description,
    public: clan.public,
    icon: clan.icon,
    iconImage: clan.iconImage || null,
    ownerUsername: clan.ownerUsername,
    members: clanMemberList(clan),
    memberCount: Object.keys(clan.roles).length,
    colorsOwned: clan.colorsOwned,
    activeColor: clan.activeColor,
    bank: {
      level: clan.bank.level,
      tokens: clan.bank.tokens,
      maxed: !!clan.bank.maxed,
      contributors: Object.keys(clan.bank.contributions || {}).length,
      bonusMinContributors: BANK_BONUS_MIN_CONTRIBUTORS
    },
    createdAt: clan.createdAt
  };
  const role = viewerKey ? clan.roles[viewerKey] : null;
  if (role === 'owner' || role === 'admin') {
    result.inviteCode = clan.inviteCode;
  }
  return result;
}

function maybeRolloverCompetition() {
  const comp = db.competition;
  if (Date.now() - comp.cycleStart < COMPETITION_CYCLE_MS) return;

  let topClanId = null, topClanScore = -1;
  Object.entries(comp.clanScores).forEach(([clanId, score]) => {
    if (score > topClanScore && db.clans[clanId]) { topClanId = clanId; topClanScore = score; }
  });
  let topUser = null, topUserScore = -1;
  Object.entries(comp.individualScores).forEach(([username, score]) => {
    if (score > topUserScore && db.users[username]) { topUser = username; topUserScore = score; }
  });

  if (topClanId && topClanScore > 0) {
    const clan = db.clans[topClanId];
    Object.keys(clan.roles).forEach(username => {
      if (db.users[username]) db.users[username].tokens += COMPETITION_CLAN_REWARD_PER_MEMBER;
    });
  }
  if (topUser && topUserScore > 0 && db.users[topUser]) {
    db.users[topUser].tokens += COMPETITION_INDIVIDUAL_REWARD;
  }

  comp.cycleNumber += 1;
  comp.cycleStart = Date.now();
  comp.clanScores = {};
  comp.individualScores = {};
}
function awardCompetitionPoint(user, amount) {
  if (!user.clanId || !db.clans[user.clanId]) return;
  const comp = db.competition;
  comp.clanScores[user.clanId] = (comp.clanScores[user.clanId] || 0) + amount;
  comp.individualScores[user.username] = (comp.individualScores[user.username] || 0) + amount;
}

app.get('/api/clans', requireAuth, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const list = Object.values(db.clans)
    .filter(c => c.public || c.id === db.users[req.username].clanId)
    .filter(c => !q || c.name.toLowerCase().includes(q) || c.tag.toLowerCase().includes(q))
    .map(publicClan)
    .sort((a, b) => b.memberCount - a.memberCount);
  res.json({ clans: list });
});

app.get('/api/clans/mine', requireAuth, (req, res) => {
  const user = db.users[req.username];
  const clan = userClan(user);
  res.json({ clan: clan ? publicClan(clan, req.username) : null });
});

app.post('/api/clans/create', requireAuth, (req, res) => {
  const user = db.users[req.username];
  if (user.clanId) return res.status(400).json({ message: 'Leave your current clan first.' });

  const { name, tag, description, isPublic } = req.body || {};
  if (typeof name !== 'string' || typeof tag !== 'string' || !name.trim() || !tag.trim()) return res.status(400).json({ message: 'A name and tag are required.' });
  if (!canAfford(user.tokens, CLAN_CREATE_COST)) return res.status(400).json({ message: `Creating a clan costs ${CLAN_CREATE_COST} tokens.` });

  user.tokens -= CLAN_CREATE_COST;

  const id = crypto.randomBytes(8).toString('hex');
  db.clans[id] = {
    id,
    name: name.slice(0, 30),
    tag: tag.slice(0, 12),
    description: String(description || '').slice(0, 100),
    public: isPublic !== false,
    icon: name.trim().charAt(0).toUpperCase() || '?',
    iconImage: null,
    ownerUsername: user.username,
    roles: { [req.username]: 'owner' },
    colorsOwned: ['gray'],
    activeColor: 'gray',
    bank: { level: 1, tokens: 0, contributions: {}, maxed: false },
    chat: [],
    inviteCode: crypto.randomBytes(4).toString('hex').toUpperCase(),
    createdAt: Date.now()
  };

  user.clanId = id;
  saveDB();
  res.json({ clan: publicClan(db.clans[id], req.username) });
});

app.post('/api/clans/join', requireAuth, (req, res) => {
  const user = db.users[req.username];
  if (user.clanId) return res.status(400).json({ message: 'Leave your current clan first.' });

  const { clanId, inviteCode } = req.body || {};
  let clan = getClan(clanId);

  if (!clan && inviteCode) {
    const code = String(inviteCode).trim().toUpperCase();
    clan = Object.values(db.clans).find(c => c.inviteCode === code);
  }
  if (!clan) return res.status(404).json({ message: 'Clan not found.' });

  if (!clan.public) {
    const submitted = String(inviteCode || '').trim().toUpperCase();
    if (!submitted || submitted !== clan.inviteCode) {
      return res.status(403).json({ message: 'Invalid invite code.' });
    }
  }

  clan.roles[req.username] = 'member';
  user.clanId = clan.id;
  saveDB();
  io.emit('identityUpdate', { username: user.username, ...chatIdentityFor(user.username) });
  res.json({ clan: publicClan(clan, req.username) });
});

app.post('/api/clans/leave', requireAuth, (req, res) => {
  const user = db.users[req.username];
  const clan = userClan(user);
  if (!clan) return res.status(400).json({ message: 'You are not in a clan.' });

  delete clan.roles[req.username];
  user.clanId = null;

  const remaining = Object.keys(clan.roles);
  if (remaining.length === 0) {
    delete db.clans[clan.id];
    removeUploadIfUnused(clan.iconImage);
  } else if (clan.ownerUsername.toLowerCase() === req.username) {
    const nextOwner = remaining.find(u => clan.roles[u] === 'admin') || remaining[0];
    clan.roles[nextOwner] = 'owner';
    clan.ownerUsername = db.users[nextOwner] ? db.users[nextOwner].username : nextOwner;
  }

  saveDB();
  io.emit('identityUpdate', { username: user.username, ...chatIdentityFor(user.username) });
  res.json({ message: 'Left the clan.' });
});

function requireClanOwner(req, res, next) {
  const user = db.users[req.username];
  const clan = userClan(user);
  if (!clan) return res.status(400).json({ message: 'You are not in a clan.' });
  if (clan.roles[req.username] !== 'owner') return res.status(403).json({ message: 'Only the clan owner can do that.' });
  req.clan = clan;
  next();
}
function requireClanMember(req, res, next) {
  const user = db.users[req.username];
  const clan = userClan(user);
  if (!clan) return res.status(400).json({ message: 'You are not in a clan.' });
  req.clan = clan;
  next();
}
function requireClanStaff(req, res, next) {
  const user = db.users[req.username];
  const clan = userClan(user);
  if (!clan) return res.status(400).json({ message: 'You are not in a clan.' });
  const role = clan.roles[req.username];
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ message: 'Owner or admin only.' });
  req.clan = clan;
  next();
}

app.post('/api/clans/members/role', requireAuth, requireClanOwner, (req, res) => {
  const { username, role } = req.body || {};
  const clan = req.clan;
  const targetKey = (typeof username === 'string' ? username : '').toLowerCase();
  if (!own(clan.roles, targetKey)) return res.status(404).json({ message: 'That player is not in your clan.' });
  if (targetKey === req.username) return res.status(400).json({ message: "You can't change your own role." });
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ message: 'Invalid role.' });

  clan.roles[targetKey] = role;
  saveDB();
  res.json({ clan: publicClan(clan, req.username) });
});

app.post('/api/clans/members/kick', requireAuth, requireClanStaff, (req, res) => {
  const { username } = req.body || {};
  const clan = req.clan;
  const targetKey = (typeof username === 'string' ? username : '').toLowerCase();
  if (!own(clan.roles, targetKey)) return res.status(404).json({ message: 'That player is not in your clan.' });
  if (clan.roles[targetKey] === 'owner') return res.status(400).json({ message: "You can't kick the owner." });
  if (clan.roles[targetKey] === 'admin' && clan.roles[req.username] !== 'owner') {
    return res.status(403).json({ message: 'Only the owner can kick an admin.' });
  }

  delete clan.roles[targetKey];
  if (db.users[targetKey]) db.users[targetKey].clanId = null;
  saveDB();
  if (db.users[targetKey]) io.emit('identityUpdate', { username: db.users[targetKey].username, ...chatIdentityFor(targetKey) });
  res.json({ clan: publicClan(clan, req.username) });
});

app.get('/api/clans/colors', requireAuth, (req, res) => {
  res.json({ colors: CLAN_COLORS });
});

app.post('/api/clans/colors/buy', requireAuth, requireClanOwner, (req, res) => {
  const { color } = req.body || {};
  const info = own(CLAN_COLORS, color);
  const clan = req.clan;
  const user = db.users[req.username];
  if (!info) return res.status(400).json({ message: 'Unknown color.' });
  if (clan.colorsOwned.includes(color)) return res.status(400).json({ message: 'Already owned.' });
  if (!canAfford(user.tokens, info.cost)) return res.status(400).json({ message: 'Not enough tokens.' });

  user.tokens -= info.cost;
  clan.colorsOwned.push(color);
  saveDB();
  res.json({ tokens: user.tokens, clan: publicClan(clan, req.username) });
});

app.post('/api/clans/colors/switch', requireAuth, requireClanOwner, (req, res) => {
  const { color } = req.body || {};
  const clan = req.clan;
  if (!clan.colorsOwned.includes(color)) return res.status(400).json({ message: "Your clan doesn't own that color yet." });

  clan.activeColor = color;
  saveDB();
  res.json({ clan: publicClan(clan, req.username) });
});

function setClanIcon(clan, image) {
  const old = clan.iconImage;
  clan.iconImage = image;
  saveDB();
  removeUploadIfUnused(old);
}

app.post('/api/clans/icon', requireAuth, requireClanOwner, (req, res) => {
  const { image } = req.body || {};
  if (String(image || '').trim()) return res.status(400).json({ message: 'Upload an image file instead of a link.' });
  setClanIcon(req.clan, null);
  res.json({ clan: publicClan(req.clan, req.username) });
});

app.post('/api/clans/icon/upload', requireAuth, requireClanOwner, uploadRateLimit, imageUpload, (req, res) => {
  setClanIcon(req.clan, saveUpload(req.body));
  res.json({ clan: publicClan(req.clan, req.username) });
});

app.post('/api/clans/visibility', requireAuth, requireClanOwner, (req, res) => {
  const { isPublic } = req.body || {};
  const clan = req.clan;

  clan.public = !!isPublic;
  saveDB();
  res.json({ clan: publicClan(clan, req.username) });
});

app.post('/api/clans/invite/regenerate', requireAuth, requireClanOwner, (req, res) => {
  const clan = req.clan;
  clan.inviteCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  saveDB();
  res.json({ clan: publicClan(clan, req.username) });
});

app.get('/api/chat/global', requireAuth, (req, res) => {
  const messages = db.globalChat.slice(-100).map(m => ({ ...m, ...chatIdentityFor(m.user) }));
  res.json({ messages });
});

app.get('/api/clans/chat', requireAuth, requireClanMember, (req, res) => {
  res.json({ messages: req.clan.chat.slice(-100) });
});

function bankBonusEligible(contributions, cap) {
  const qualifying = Object.entries(contributions)
    .filter(([key, amt]) => amt >= cap * BANK_BONUS_MIN_SHARE && own(db.users, key))
    .map(([key]) => db.users[key]);
  const usedNetworks = new Set();
  let distinct = 0;
  qualifying.forEach(u => {
    if (u.ipHashes.some(h => usedNetworks.has(h))) return;
    u.ipHashes.forEach(h => usedNetworks.add(h));
    distinct++;
  });
  return distinct >= BANK_BONUS_MIN_CONTRIBUTORS;
}

app.post('/api/clans/bank/deposit', requireAuth, requireClanMember, (req, res) => {
  const user = db.users[req.username];
  const clan = req.clan;
  let amount = Math.floor(Number((req.body || {}).amount));
  const bank = clan.bank;
  bank.contributions = bank.contributions || {};

  if (bank.maxed) return res.status(400).json({ message: 'Your clan bank is already fully maxed out.' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'Enter a valid amount.' });
  const cap = CLAN_BANK_LEVELS[bank.level - 1];
  amount = Math.max(0, Math.min(amount, cap - bank.tokens));
  if (!canAfford(user.tokens, amount)) return res.status(400).json({ message: 'Not enough tokens.' });

  const now = Date.now();
  if (now - user.hourlyDeposit.windowStart > 3600000) {
    user.hourlyDeposit = { amount: 0, windowStart: now };
  }
  if (user.hourlyDeposit.amount + amount > HOURLY_DEPOSIT_LIMIT) {
    return res.status(400).json({ message: `That would exceed your hourly deposit limit of ${HOURLY_DEPOSIT_LIMIT.toLocaleString('en-US')}.` });
  }

  user.tokens -= amount;
  user.hourlyDeposit.amount += amount;
  bank.tokens += amount;
  bank.contributions[req.username] = (bank.contributions[req.username] || 0) + amount;

  let filled = false, doubled = false;
  if (bank.tokens >= cap) {
    filled = true;
    doubled = bankBonusEligible(bank.contributions, cap);
    const multiplier = doubled ? 2 : 1;
    let attributed = 0;
    Object.entries(bank.contributions).forEach(([key, amt]) => {
      attributed += amt;
      const u = own(db.users, key);
      if (u) u.tokens += amt * multiplier;
    });
    const legacy = Math.max(0, bank.tokens - attributed);
    if (legacy > 0) {
      const memberKeys = Object.keys(clan.roles);
      const share = Math.floor(legacy / memberKeys.length);
      memberKeys.forEach(k => { const u = own(db.users, k); if (u) u.tokens += share; });
    }
    bank.contributions = {};
    bank.tokens = 0;
    if (bank.level >= CLAN_BANK_LEVELS.length) bank.maxed = true;
    else bank.level += 1;
  }

  saveDB();
  res.json({
    tokens: db.users[req.username].tokens,
    bank: publicClan(clan, req.username).bank,
    deposited: amount,
    filled,
    doubled,
    hourlyDepositLeft: HOURLY_DEPOSIT_LIMIT - user.hourlyDeposit.amount
  });
});

app.post('/api/clans/donate', requireAuth, requireClanMember, (req, res) => {
  const user = db.users[req.username];
  const clan = req.clan;
  const { toUsername, type, amount, packKey, name } = req.body || {};

  const targetKey = (typeof toUsername === 'string' ? toUsername : '').toLowerCase();
  if (!own(clan.roles, targetKey)) return res.status(400).json({ message: 'That player is not in your clan.' });
  if (targetKey === req.username) return res.status(400).json({ message: "You can't donate to yourself." });
  const recipient = own(db.users, targetKey);
  if (!recipient) return res.status(404).json({ message: 'Player not found.' });

  if (type === 'tokens') {
    const amt = Math.floor(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: 'Enter a valid amount.' });
    if (!canAfford(user.tokens, amt)) return res.status(400).json({ message: 'Not enough tokens.' });
    user.tokens -= amt;
    recipient.tokens += amt;
  } else if (type === 'blook') {
    const pack = own(PACK_CONFIGS, packKey);
    const blook = pack && pack.rates.find(r => r.name === name);
    if (!blook) return res.status(400).json({ message: 'Unknown blook.' });
    const key = packKey + '::' + name;
    const owned = user.collection[key] || 0;
    const qty = Math.max(1, parseInt(amount, 10) || 1);
    if (qty > owned) return res.status(400).json({ message: "You don't own that many." });
    user.collection[key] = owned - qty;
    if (user.collection[key] <= 0) delete user.collection[key];
    recipient.collection[key] = (recipient.collection[key] || 0) + qty;
  } else {
    return res.status(400).json({ message: 'Unknown donation type.' });
  }

  saveDB();
  res.json({ tokens: user.tokens, collection: user.collection });
});

app.get('/api/clans/competition', requireAuth, (req, res) => {
  maybeRolloverCompetition();
  saveDB();

  const comp = db.competition;
  const clanBoard = Object.entries(comp.clanScores)
    .filter(([clanId]) => db.clans[clanId])
    .map(([clanId, score]) => ({ clan: publicClan(db.clans[clanId]), score }))
    .sort((a, b) => b.score - a.score);

  Object.values(db.clans).forEach(c => {
    if (!comp.clanScores[c.id]) clanBoard.push({ clan: publicClan(c), score: 0 });
  });
  clanBoard.sort((a, b) => b.score - a.score);

  const individualBoard = Object.entries(comp.individualScores)
    .filter(([username]) => db.users[username])
    .map(([username, score]) => ({ username: db.users[username].username, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  res.json({
    cycleNumber: comp.cycleNumber,
    cycleEndsAt: comp.cycleStart + COMPETITION_CYCLE_MS,
    clanRewardPerMember: COMPETITION_CLAN_REWARD_PER_MEMBER,
    individualReward: COMPETITION_INDIVIDUAL_REWARD,
    clanBoard,
    individualBoard
  });
});

function emitToUser(username, event, payload) {
  io.to('user:' + username.toLowerCase()).emit(event, payload);
}

function normalizeItemList(items) {
  const out = {};
  if (items != null && !Array.isArray(items)) throw 'Invalid blook list.';
  (items || []).forEach(item => {
    if (!item || typeof item !== 'object') throw 'Invalid blook list.';
    const pack = own(PACK_CONFIGS, item.packKey);
    const blook = pack && pack.rates.find(r => r.name === item.name);
    if (!blook) throw `Unknown blook: ${item.name || '?'}`;
    const qty = Math.min(1e6, Math.max(1, parseInt(item.qty, 10) || 1));
    const key = item.packKey + '::' + item.name;
    out[key] = (out[key] || 0) + qty;
  });
  return out;
}

function userHasItems(user, tokens, blooks) {
  if (!canAfford(user.tokens, tokens)) return false;
  return Object.entries(blooks).every(([key, qty]) => (user.collection[key] || 0) >= qty);
}

function blookDisplay(key, qty) {
  const [packKey, name] = key.split('::');
  const pack = own(PACK_CONFIGS, packKey);
  const blook = pack && pack.rates.find(r => r.name === name);
  return {
    packKey,
    name,
    qty,
    image: blook ? blook.item : null,
    type: blook ? blook.type : null,
    packLabel: pack ? pack.label : packKey
  };
}

function isUserOnline(key) {
  for (const v of onlineUsers.values()) {
    if (v && v.toLowerCase() === key) return true;
  }
  return false;
}

function publicTrade(t, viewerKey) {
  const sides = {};
  Object.entries(t.sides).forEach(([key, side]) => {
    sides[key] = {
      tokens: side.tokens,
      blooks: Object.entries(side.blooks).map(([k, q]) => blookDisplay(k, q))
    };
  });
  const otherKey = viewerKey === t.fromKey ? t.toKey : t.fromKey;
  return {
    id: t.id,
    from: t.fromUsername,
    to: t.toUsername,
    fromKey: t.fromKey,
    toKey: t.toKey,
    status: t.status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    sides,
    myKey: viewerKey || null,
    myConfirmed: !!(viewerKey && t.confirmed && t.confirmed[viewerKey]),
    otherConfirmed: !!(viewerKey && t.confirmed && t.confirmed[otherKey]),
    otherUsername: viewerKey ? (db.users[otherKey] ? db.users[otherKey].username : otherKey) : null,
    otherOnline: viewerKey ? isUserOnline(otherKey) : undefined,
    chat: t.chat
  };
}

function broadcastTradeUpdate(trade) {
  emitToUser(trade.fromUsername, 'tradeUpdate', { tradeId: trade.id, trade: publicTrade(trade, trade.fromKey) });
  emitToUser(trade.toUsername, 'tradeUpdate', { tradeId: trade.id, trade: publicTrade(trade, trade.toKey) });
}

app.post('/api/trades', requireAuth, (req, res) => {
  const { toUsername } = req.body || {};
  const fromUser = db.users[req.username];
  const toUser = getUser(toUsername);

  if (!toUser) return res.status(404).json({ message: 'No player with that username.' });
  const toKey = toUser.username.toLowerCase();
  if (toKey === req.username) return res.status(400).json({ message: "You can't trade with yourself." });

  const existing = db.trades.find(t => t.status === 'negotiating' &&
    ((t.fromKey === req.username && t.toKey === toKey) || (t.fromKey === toKey && t.toKey === req.username)));
  if (existing) return res.json({ trade: publicTrade(existing, req.username) });

  const trade = {
    id: crypto.randomBytes(8).toString('hex'),
    fromUsername: fromUser.username,
    toUsername: toUser.username,
    fromKey: req.username,
    toKey,
    status: 'negotiating',
    confirmed: {},
    sides: {
      [req.username]: { tokens: 0, blooks: {} },
      [toKey]: { tokens: 0, blooks: {} }
    },
    chat: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  db.trades.push(trade);
  saveDB();

  broadcastTradeUpdate(trade);
  res.json({ trade: publicTrade(trade, req.username) });
});

app.get('/api/trades', requireAuth, (req, res) => {
  const type = req.query.type === 'history' ? 'history' : 'active';
  const key = req.username;

  let list = db.trades.filter(t => t.fromKey === key || t.toKey === key);
  list = list.filter(t => type === 'active' ? t.status === 'negotiating' : t.status !== 'negotiating');
  list = list.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(t => publicTrade(t, key));
  res.json({ trades: list });
});

app.get('/api/trades/:id', requireAuth, (req, res) => {
  const trade = db.trades.find(t => t.id === req.params.id);
  if (!trade) return res.status(404).json({ message: 'Trade not found.' });
  if (trade.fromKey !== req.username && trade.toKey !== req.username) return res.status(403).json({ message: 'Not your trade.' });
  res.json({ trade: publicTrade(trade, req.username) });
});

app.post('/api/trades/:id/offer', requireAuth, (req, res) => {
  const trade = db.trades.find(t => t.id === req.params.id);
  if (!trade) return res.status(404).json({ message: 'Trade not found.' });
  if (trade.fromKey !== req.username && trade.toKey !== req.username) return res.status(403).json({ message: 'Not your trade.' });
  if (trade.status !== 'negotiating') return res.status(400).json({ message: 'This trade is no longer open.' });

  const { tokens, blooks } = req.body || {};
  const tokensNum = Math.max(0, Math.floor(Number(tokens)) || 0);
  if (tokensNum > MAX_TOKEN_AMOUNT) return res.status(400).json({ message: 'That amount is too large.' });
  let blooksObj;
  try {
    blooksObj = normalizeItemList(blooks);
  } catch (msg) {
    return res.status(400).json({ message: msg });
  }

  const user = db.users[req.username];
  if (!userHasItems(user, tokensNum, blooksObj)) {
    return res.status(400).json({ message: "You don't have everything you're trying to add." });
  }

  trade.sides[req.username] = { tokens: tokensNum, blooks: blooksObj };
  trade.confirmed = {};
  trade.updatedAt = Date.now();
  saveDB();

  broadcastTradeUpdate(trade);
  res.json({ trade: publicTrade(trade, req.username) });
});

app.post('/api/trades/:id/accept', requireAuth, (req, res) => {
  const trade = db.trades.find(t => t.id === req.params.id);
  if (!trade) return res.status(404).json({ message: 'Trade not found.' });
  if (trade.fromKey !== req.username && trade.toKey !== req.username) return res.status(403).json({ message: 'Not your trade.' });
  if (trade.status !== 'negotiating') return res.status(400).json({ message: 'This trade is no longer open.' });

  const fromUser = db.users[trade.fromKey];
  const toUser = db.users[trade.toKey];
  if (!fromUser || !toUser) return res.status(404).json({ message: 'A trader in this offer no longer exists.' });

  const fromSide = trade.sides[trade.fromKey];
  const toSide = trade.sides[trade.toKey];

  trade.confirmed = trade.confirmed || {};
  if (!trade.confirmed[req.username]) {
    trade.confirmed[req.username] = true;
    trade.updatedAt = Date.now();
  }
  if (!trade.confirmed[trade.fromKey] || !trade.confirmed[trade.toKey]) {
    saveDB();
    broadcastTradeUpdate(trade);
    return res.json({ trade: publicTrade(trade, req.username) });
  }

  if (!userHasItems(fromUser, fromSide.tokens, fromSide.blooks)) {
    trade.confirmed = {};
    return res.status(400).json({ message: `${fromUser.username} no longer has everything in their offer.` });
  }
  if (!userHasItems(toUser, toSide.tokens, toSide.blooks)) {
    trade.confirmed = {};
    return res.status(400).json({ message: `${toUser.username} no longer has everything in their offer.` });
  }

  fromUser.tokens -= fromSide.tokens;
  toUser.tokens += fromSide.tokens;
  toUser.tokens -= toSide.tokens;
  fromUser.tokens += toSide.tokens;

  Object.entries(fromSide.blooks).forEach(([itemKey, qty]) => {
    fromUser.collection[itemKey] -= qty;
    if (fromUser.collection[itemKey] <= 0) delete fromUser.collection[itemKey];
    toUser.collection[itemKey] = (toUser.collection[itemKey] || 0) + qty;
  });
  Object.entries(toSide.blooks).forEach(([itemKey, qty]) => {
    toUser.collection[itemKey] -= qty;
    if (toUser.collection[itemKey] <= 0) delete toUser.collection[itemKey];
    fromUser.collection[itemKey] = (fromUser.collection[itemKey] || 0) + qty;
  });

  trade.status = 'accepted';
  trade.updatedAt = Date.now();
  saveDB();

  broadcastTradeUpdate(trade);
  res.json({ trade: publicTrade(trade, req.username) });
});

app.post('/api/trades/:id/decline', requireAuth, (req, res) => {
  const trade = db.trades.find(t => t.id === req.params.id);
  if (!trade) return res.status(404).json({ message: 'Trade not found.' });
  if (trade.fromKey !== req.username && trade.toKey !== req.username) return res.status(403).json({ message: 'Not your trade.' });
  if (trade.status !== 'negotiating') return res.status(400).json({ message: 'This trade is no longer open.' });

  trade.status = 'declined';
  trade.updatedAt = Date.now();
  saveDB();

  broadcastTradeUpdate(trade);
  res.json({ trade: publicTrade(trade, req.username) });
});

app.get('/api/trades/:id/chat', requireAuth, (req, res) => {
  const trade = db.trades.find(t => t.id === req.params.id);
  if (!trade) return res.status(404).json({ message: 'Trade not found.' });
  if (trade.fromKey !== req.username && trade.toKey !== req.username) return res.status(403).json({ message: 'Not your trade.' });
  res.json({ messages: trade.chat });
});

app.get('/api/players/lookup', requireAuth, (req, res) => {
  const user = getUser(req.query.username);
  if (!user) return res.status(404).json({ message: 'No player with that username.' });
  res.json({ username: user.username });
});

function publicListing(l) {
  const display = blookDisplay(l.itemKey, 1);
  return {
    id: l.id,
    seller: l.sellerUsername,
    price: l.price,
    createdAt: l.createdAt,
    packKey: display.packKey,
    name: display.name,
    image: display.image,
    type: display.type,
    packLabel: display.packLabel
  };
}

app.post('/api/bazaar/listings', requireAuth, (req, res) => {
  const { packKey, name, price } = req.body || {};
  const pack = own(PACK_CONFIGS, packKey);
  const blook = pack && pack.rates.find(r => r.name === name);
  if (!blook) return res.status(400).json({ message: 'Unknown blook.' });

  const priceNum = Math.floor(Number(price));
  if (!Number.isFinite(priceNum) || priceNum <= 0 || priceNum > MAX_TOKEN_AMOUNT) return res.status(400).json({ message: 'Enter a valid price.' });

  const user = db.users[req.username];
  const itemKey = packKey + '::' + name;
  const owned = user.collection[itemKey] || 0;
  if (owned < 1) return res.status(400).json({ message: "You don't own that blook." });

  user.collection[itemKey] -= 1;
  if (user.collection[itemKey] <= 0) delete user.collection[itemKey];

  const listing = {
    id: crypto.randomBytes(8).toString('hex'),
    sellerUsername: user.username,
    sellerKey: req.username,
    itemKey,
    price: priceNum,
    status: 'active',
    createdAt: Date.now()
  };
  db.listings.push(listing);
  saveDB();

  io.emit('bazaarUpdate');
  res.json({ listing: publicListing(listing), collection: user.collection });
});

app.get('/api/bazaar/listings', requireAuth, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const packKey = req.query.packKey;
  const name = req.query.name;
  let list = db.listings.filter(l => l.status === 'active');

  if (packKey && name) {
    const itemKey = packKey + '::' + name;
    list = list.filter(l => l.itemKey === itemKey);
  } else if (q) {
    list = list.filter(l => {
      const [, n] = l.itemKey.split('::');
      return n.toLowerCase().includes(q);
    });
  }

  list = list.slice().sort((a, b) => a.price - b.price).map(l => ({
    ...publicListing(l),
    isMine: l.sellerKey === req.username
  }));
  res.json({ listings: list });
});

app.get('/api/bazaar/mine', requireAuth, (req, res) => {
  const list = db.listings
    .filter(l => l.sellerKey === req.username && l.status === 'active')
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicListing);
  res.json({ listings: list });
});

app.post('/api/bazaar/listings/:id/buy', requireAuth, (req, res) => {
  const listing = db.listings.find(l => l.id === req.params.id);
  if (!listing || listing.status !== 'active') return res.status(404).json({ message: 'That listing is no longer available.' });
  if (listing.sellerKey === req.username) return res.status(400).json({ message: "You can't buy your own listing." });

  const buyer = db.users[req.username];
  const seller = db.users[listing.sellerKey];
  if (!canAfford(buyer.tokens, listing.price)) return res.status(400).json({ message: 'Not enough tokens.' });

  buyer.tokens -= listing.price;
  if (seller) seller.tokens += listing.price;
  buyer.collection[listing.itemKey] = (buyer.collection[listing.itemKey] || 0) + 1;

  listing.status = 'sold';
  listing.updatedAt = Date.now();
  saveDB();

  io.emit('bazaarUpdate');
  if (seller) emitToUser(seller.username, 'bazaarSold', { listingId: listing.id });

  res.json({ tokens: buyer.tokens, collection: buyer.collection });
});

app.post('/api/bazaar/listings/:id/cancel', requireAuth, (req, res) => {
  const listing = db.listings.find(l => l.id === req.params.id);
  if (!listing || listing.status !== 'active') return res.status(404).json({ message: 'That listing is no longer available.' });
  if (listing.sellerKey !== req.username) return res.status(403).json({ message: 'Not your listing.' });

  const seller = db.users[req.username];
  seller.collection[listing.itemKey] = (seller.collection[listing.itemKey] || 0) + 1;

  listing.status = 'cancelled';
  listing.updatedAt = Date.now();
  saveDB();

  io.emit('bazaarUpdate');
  res.json({ collection: seller.collection });
});

app.get('/api/owner/stats', requireAuth, requireOwner, (req, res) => {
  const users = Object.values(db.users);
  const totalTokens = users.reduce((sum, u) => sum + (u.tokens || 0), 0);
  const bannedCount = users.filter(u => u.banned && u.banned.active).length;
  const pendingTrades = db.trades.filter(t => t.status === 'negotiating').length;
  const activeListings = db.listings.filter(l => l.status === 'active').length;

  res.json({
    totalUsers: users.length,
    totalAdmins: users.filter(u => u.isAdmin).length,
    totalOwners: users.filter(u => u.isOwner).length,
    bannedCount,
    totalTokensInEconomy: totalTokens,
    totalClans: Object.keys(db.clans).length,
    totalTrades: db.trades.length,
    pendingTrades,
    activeListings,
    totalNewsPosts: db.news.length,
    competitionCycle: db.competition.cycleNumber
  });
});

app.get('/api/owner/admins', requireAuth, requireOwner, (req, res) => {
  const admins = Object.values(db.users)
    .filter(u => u.isAdmin)
    .map(u => ({ username: u.username, isOwner: !!u.isOwner }));
  res.json({ admins });
});

app.post('/api/owner/grant-admin', requireAuth, requireOwner, (req, res) => {
  const user = getUser((req.body || {}).username);
  if (!user) return res.status(404).json({ message: 'No such player.' });
  user.isAdmin = true;
  saveDB();
  res.json({ message: `${user.username} is now an admin.` });
});

app.post('/api/owner/revoke-admin', requireAuth, requireOwner, (req, res) => {
  const user = getUser((req.body || {}).username);
  if (!user) return res.status(404).json({ message: 'No such player.' });
  if (user.isOwner) return res.status(400).json({ message: "Can't revoke admin from an owner." });
  user.isAdmin = false;
  saveDB();
  res.json({ message: `${user.username} is no longer an admin.` });
});

app.post('/api/owner/give-tokens', requireAuth, requireOwner, (req, res) => {
  const { username, amount } = req.body || {};
  const user = getUser(username);
  if (!user) return res.status(404).json({ message: 'No such player.' });

  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt === 0) return res.status(400).json({ message: 'Enter a non-zero amount.' });
  if (Math.abs(amt) > MAX_TOKEN_AMOUNT) return res.status(400).json({ message: 'That amount is too large.' });
  if (amt < 0 && user.tokens + amt < 0) return res.status(400).json({ message: "That player doesn't have that many tokens to remove." });

  user.tokens += amt;
  saveDB();
  res.json({ message: `${user.username} now has ${user.tokens.toLocaleString('en-US')} tokens.`, tokens: user.tokens });
});

app.post('/api/owner/set-tokens', requireAuth, requireOwner, (req, res) => {
  const { username, amount } = req.body || {};
  const user = getUser(username);
  if (!user) return res.status(404).json({ message: 'No such player.' });
  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt < 0 || amt > MAX_TOKEN_AMOUNT) return res.status(400).json({ message: 'Enter an amount of 0 or more.' });
  user.tokens = amt;
  saveDB();
  res.json({ message: `${user.username} now has ${amt.toLocaleString('en-US')} tokens.`, tokens: amt });
});

app.post('/api/owner/reset-economy', requireAuth, requireOwner, (req, res) => {
  const user = getUser((req.body || {}).username);
  if (!user) return res.status(404).json({ message: 'No such player.' });
  if (user.isOwner) return res.status(400).json({ message: "Can't reset an owner's account." });
  const key = user.username.toLowerCase();
  user.tokens = STARTING_TOKENS;
  user.rubies = 0;
  user.collection = {};
  user.booster = null;
  user.packsOpened = 0;
  db.listings.forEach(l => {
    if (l.status === 'active' && l.sellerKey === key) { l.status = 'cancelled'; l.updatedAt = Date.now(); }
  });
  db.trades.forEach(t => {
    if (t.status === 'negotiating' && (t.fromKey === key || t.toKey === key)) { t.status = 'declined'; t.updatedAt = Date.now(); }
  });
  saveDB();
  io.emit('bazaarUpdate');
  res.json({ message: `Reset ${user.username}: ${STARTING_TOKENS} tokens, no blooks, no rubies.` });
});

app.post('/api/owner/delete-account', requireAuth, requireOwner, (req, res) => {
  const targetUsername = (req.body || {}).username;
  const user = getUser(targetUsername);
  if (!user) return res.status(404).json({ message: 'No such player.' });

  const key = user.username.toLowerCase();
  if (user.isOwner) return res.status(400).json({ message: "Can't delete another owner's account." });

  const clan = userClan(user);
  if (clan) {
    delete clan.roles[key];
    const remaining = Object.keys(clan.roles);
    if (remaining.length === 0) {
      delete db.clans[clan.id];
      removeUploadIfUnused(clan.iconImage);
    } else if (clan.ownerUsername.toLowerCase() === key) {
      const nextOwner = remaining.find(u => clan.roles[u] === 'admin') || remaining[0];
      clan.roles[nextOwner] = 'owner';
      clan.ownerUsername = db.users[nextOwner] ? db.users[nextOwner].username : nextOwner;
    }
  }

  db.trades.forEach(t => {
    if (t.status === 'negotiating' && (t.fromKey === key || t.toKey === key)) {
      t.status = 'declined';
      t.updatedAt = Date.now();
    }
  });

  db.listings.forEach(l => {
    if (l.status === 'active' && l.sellerKey === key) {
      l.status = 'cancelled';
      l.updatedAt = Date.now();
    }
  });

  Object.keys(db.sessions).forEach(token => {
    if (db.sessions[token].user === key) deleteSession(token);
  });

  delete db.users[key];
  saveDB();
  removeUploadIfUnused(user.avatar);

  io.emit('bazaarUpdate');
  res.json({ message: `${targetUsername}'s account has been deleted.` });
});

app.get('/api/admin/user/:username', requireAuth, requireAdmin, (req, res) => {
  const user = getUser(req.params.username);
  if (!user) return res.status(404).json({ message: 'No such player.' });
  res.json({ user: publicUser(user) });
});

app.post('/api/admin/give-blook', requireAuth, requireAdmin, (req, res) => {
  const { username, packKey, name } = req.body || {};
  const user = getUser(username);
  if (!user) return res.status(404).json({ message: 'No such player.' });
  const pack = own(PACK_CONFIGS, packKey);
  if (!pack || !pack.rates.some(r => r.name === name)) return res.status(400).json({ message: 'Unknown blook.' });

  const key = packKey + '::' + name;
  user.collection[key] = (user.collection[key] || 0) + 1;
  saveDB();
  res.json({ message: `Gave ${name} to ${user.username}.` });
});

app.post('/api/admin/give-all', requireAuth, requireAdmin, (req, res) => {
  const { username } = req.body || {};
  const user = getUser(username);
  if (!user) return res.status(404).json({ message: 'No such player.' });

  Object.entries(PACK_CONFIGS).forEach(([packKey, cfg]) => {
    cfg.rates.forEach(b => {
      const key = packKey + '::' + b.name;
      user.collection[key] = (user.collection[key] || 0) + 1;
    });
  });
  saveDB();
  res.json({ message: `Gave every blook to ${user.username}.` });
});

app.post('/api/admin/ban', requireAuth, requireAdmin, (req, res) => {
  const { username, amount, unit } = req.body || {};
  const user = getUser(username);
  if (!user) return res.status(404).json({ message: 'No such player.' });
  if (!canModerate(db.users[req.username], user)) return res.status(403).json({ message: "You can't moderate that account." });

  let until = null;
  if (unit !== 'Permanent') {
    const msPerUnit = { Hours: 3600000, Days: 86400000, Weeks: 604800000 }[unit] || 86400000;
    until = Date.now() + (parseInt(amount, 10) || 1) * msPerUnit;
  }
  user.banned = { active: true, amount: parseInt(amount, 10) || 1, unit: unit || 'Days', until };
  kickUser(user);
  saveDB();
  res.json({ message: `${user.username} banned.`, banned: user.banned });
});

app.post('/api/admin/unban', requireAuth, requireAdmin, (req, res) => {
  const { username } = req.body || {};
  const user = getUser(username);
  if (!user) return res.status(404).json({ message: 'No such player.' });
  if (!canModerate(db.users[req.username], user)) return res.status(403).json({ message: "You can't moderate that account." });
  user.banned = { active: false };
  saveDB();
  res.json({ message: `${user.username} unbanned.` });
});

app.post('/api/admin/mute', requireAuth, requireAdmin, (req, res) => {
  const { username } = req.body || {};
  const user = getUser(username);
  if (!user) return res.status(404).json({ message: 'No such player.' });
  if (!canModerate(db.users[req.username], user)) return res.status(403).json({ message: "You can't moderate that account." });
  user.muted = true;
  saveDB();
  res.json({ message: `${user.username} muted.` });
});

app.post('/api/admin/unmute', requireAuth, requireAdmin, (req, res) => {
  const { username } = req.body || {};
  const user = getUser(username);
  if (!user) return res.status(404).json({ message: 'No such player.' });
  if (!canModerate(db.users[req.username], user)) return res.status(403).json({ message: "You can't moderate that account." });
  user.muted = false;
  saveDB();
  res.json({ message: `${user.username} unmuted.` });
});

function kickUser(user) {
  const key = user.username.toLowerCase();
  Object.keys(db.sessions).forEach(token => {
    if (db.sessions[token].user === key) deleteSession(token);
  });
  battleHandleDisconnectOrLeave(user.username);
  io.in('user:' + key).disconnectSockets(true);
}

function disconnectBannedNetworks() {
  io.sockets.sockets.forEach(sock => {
    if (!isIPBanned(sock.data.ipHash)) return;
    const u = sock.data.userKey && own(db.users, sock.data.userKey);
    if (!isStaff(u)) sock.disconnect(true);
  });
}

function permaBan(user) {
  user.banned = { active: true, amount: 1, unit: 'Permanent', until: null };
  kickUser(user);
}

app.post('/api/admin/ip-ban', requireAuth, requireAdmin, (req, res) => {
  const user = getUser((req.body || {}).username);
  if (!user) return res.status(404).json({ message: 'No such player.' });
  const actor = db.users[req.username];
  if (!canModerate(actor, user)) return res.status(403).json({ message: "You can't moderate that account." });
  if (user.ipHashes.length === 0) return res.status(400).json({ message: `No IPs recorded for ${user.username} yet — they need to log in once first.` });
  if (user.ipHashes.some(h => actor.ipHashes.includes(h))) {
    return res.status(400).json({ message: "That player shares a network with you — banning it would ban you too." });
  }
  const added = banIPsOf(user, actor.username);
  permaBan(user);
  disconnectBannedNetworks();
  saveDB();
  res.json({ message: `Banned ${user.username} and ${added} IP${added === 1 ? '' : 's'}.` });
});

app.get('/api/admin/alts/:username', requireAuth, requireAdmin, (req, res) => {
  const user = getUser(req.params.username);
  if (!user) return res.status(404).json({ message: 'No such player.' });
  const mine = new Set(user.ipHashes);
  const alts = linkedAccounts(user).map(u => ({
    username: u.username,
    sharedIPs: u.ipHashes.filter(h => mine.has(h)).length,
    banned: isBanned(u),
    isStaff: isStaff(u),
    tokens: u.tokens,
    createdAt: u.createdAt || null
  })).sort((a, b) => b.sharedIPs - a.sharedIPs);
  res.json({ username: user.username, ipCount: user.ipHashes.length, alts });
});

app.post('/api/admin/ban-alts', requireAuth, requireAdmin, (req, res) => {
  const { username, includeSelf } = req.body || {};
  const user = getUser(username);
  if (!user) return res.status(404).json({ message: 'No such player.' });
  const actor = db.users[req.username];
  const targets = linkedAccounts(user).filter(u => !isBanned(u) && canModerate(actor, u));
  if (includeSelf && !isBanned(user) && canModerate(actor, user)) targets.push(user);
  targets.forEach(permaBan);
  saveDB();
  res.json({ message: `Banned ${targets.length} account${targets.length === 1 ? '' : 's'}.`, banned: targets.map(u => u.username) });
});

app.get('/api/admin/bans', requireAuth, requireAdmin, (req, res) => {
  const byPlayer = {};
  Object.entries(db.ipBans).forEach(([hash, info]) => {
    const e = byPlayer[info.player] || (byPlayer[info.player] = { player: info.player, count: 0, bannedBy: info.bannedBy, at: info.at });
    e.count++;
  });
  const banned = Object.values(db.users).filter(isBanned).map(u => ({ player: u.username, unit: u.banned.unit, until: u.banned.until || null }));
  res.json({ ips: Object.values(byPlayer).sort((a, b) => b.at - a.at), accounts: banned });
});

app.post('/api/admin/unban-ip', requireAuth, requireAdmin, (req, res) => {
  const name = String((req.body || {}).username || '').toLowerCase();
  let removed = 0;
  Object.keys(db.ipBans).forEach(h => {
    if (db.ipBans[h].player.toLowerCase() === name) { delete db.ipBans[h]; removed++; }
  });
  if (!removed) return res.status(404).json({ message: 'No IP bans for that player.' });
  saveDB();
  res.json({ message: `Removed ${removed} IP ban${removed === 1 ? '' : 's'}.` });
});

app.get('/api/admin/reports', requireAuth, requireAdmin, (req, res) => {
  res.json({ reports: db.reports });
});

app.post('/api/admin/reports/:id/resolve', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action } = req.body || {};
  const report = db.reports.find(r => r.id === id);
  if (!report) return res.status(404).json({ message: 'Report not found.' });

  const user = getUser(report.author);
  const actor = db.users[req.username];
  if (user && action && action !== 'dismiss' && !canModerate(actor, user)) {
    return res.status(403).json({ message: "You can't moderate that account." });
  }
  if (user) {
    if (action === 'mute') user.muted = true;
    if (action === 'ban') permaBan(user);
    if (action === 'ipban') {
      if (user.ipHashes.some(h => actor.ipHashes.includes(h))) {
        return res.status(400).json({ message: "That player shares a network with you — banning it would ban you too." });
      }
      banIPsOf(user, actor.username);
      permaBan(user);
      disconnectBannedNetworks();
    }
  }
  db.reports = db.reports.filter(r => r.id !== id);
  saveDB();
  res.json({ reports: db.reports });
});

app.get('/api/battle/state', requireAuth, (req, res) => {
  res.json({
    state: battleMatch.state,
    players: Object.values(battleMatch.players).map(p => ({ username: p.username, blookImage: p.blookImage, x: p.x, y: p.y, hp: p.hp, alive: p.alive })),
    minPlayers: BATTLE_MIN_PLAYERS,
    countdownEndsAt: battleMatch.countdownEndsAt,
    radius: battleMatch.state === 'active' ? currentSafeRadius() : BATTLE_MAX_RADIUS,
    arenaSize: BATTLE_ARENA_SIZE,
    center: BATTLE_CENTER,
    resultsPlacements: battleMatch.state === 'ended' ? battleMatch.resultsPlacements : null,
    winner: battleMatch.winner
  });
});

app.get('/api/news', (req, res) => {
  const sorted = [...db.news].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });
  res.json({ news: sorted });
});
app.post('/api/admin/news', requireAuth, requireAdmin, (req, res) => {
  const { title, body, image, pinned } = req.body || {};
  if (!title || !body) return res.status(400).json({ message: 'Title and body are required.' });
  const author = db.users[req.username];
  db.news.unshift({
    id: Date.now(),
    title,
    body,
    image: image || null,
    pinned: !!pinned,
    timestamp: new Date().toISOString(),
    author: author.username,
    authorIsAdmin: !!author.isAdmin
  });
  saveDB();
  res.json({ news: db.news });
});
app.delete('/api/admin/news/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const before = db.news.length;
  db.news = db.news.filter(n => n.id !== id);
  if (db.news.length === before) return res.status(404).json({ message: 'Post not found.' });
  saveDB();
  res.json({ news: db.news });
});

const onlineUsers = new Map();
function broadcastUserCount() {
  const uniqueUsers = new Set(onlineUsers.values());
  io.emit('updateUserCount', uniqueUsers.size);
}

const RUBY_INTERVAL_MINUTES = 30;
const RUBY_TICK_MS = 60 * 1000;
const RUBY_DISCONNECT_GRACE_MS = 15 * 1000;

const rubySessionMinutes = new Map();
const rubyResetTimers = new Map();

function cancelPendingRubyReset(key) {
  if (rubyResetTimers.has(key)) {
    clearTimeout(rubyResetTimers.get(key));
    rubyResetTimers.delete(key);
  }
}

function scheduleRubyResetIfOffline(key) {
  cancelPendingRubyReset(key);
  const timer = setTimeout(() => {
    rubyResetTimers.delete(key);
    if (!isUserOnline(key)) {
      rubySessionMinutes.delete(key);
    }
  }, RUBY_DISCONNECT_GRACE_MS);
  rubyResetTimers.set(key, timer);
}

setInterval(() => {
  const uniqueOnline = new Set([...onlineUsers.values()].map(u => u.toLowerCase()));
  let changed = false;
  uniqueOnline.forEach(key => {
    const user = db.users[key];
    if (!user) return;
    const mins = (rubySessionMinutes.get(key) || 0) + 1;
    if (mins >= RUBY_INTERVAL_MINUTES) {
      user.rubies = (user.rubies || 0) + 1;
      rubySessionMinutes.set(key, 0);
      changed = true;
      emitToUser(user.username, 'rubyEarned', { rubies: user.rubies });
    } else {
      rubySessionMinutes.set(key, mins);
    }
  });
  if (changed) saveDB();
}, RUBY_TICK_MS);

const BATTLE_ARENA_SIZE = 800;
const BATTLE_CENTER = { x: 400, y: 400 };
const BATTLE_MAX_RADIUS = 380;
const BATTLE_MIN_RADIUS = 36;
const BATTLE_SHRINK_DURATION_MS = 90000;
const BATTLE_TICK_MS = 150;
const BATTLE_MOVE_SPEED = 4.2;
const BATTLE_ZONE_DAMAGE_PER_TICK = 4;
const BATTLE_START_HP = 100;
const BATTLE_MIN_PLAYERS = 2;
const BATTLE_COUNTDOWN_MS = 12000;
const BATTLE_RESULTS_DISPLAY_MS = 9000;
const BATTLE_REWARDS = { 1: 1000, 2: 400, 3: 200 };
const BATTLE_DEFAULT_REWARD = 50;

function freshBattleLobby() {
  return {
    state: 'waiting',
    players: {},
    countdownEndsAt: null,
    shrinkStartedAt: null,
    eliminationOrder: [],
    winner: null,
    resultsPlacements: null
  };
}
let battleMatch = freshBattleLobby();
let battleTickInterval = null;

function battlePlayerCount() {
  return Object.keys(battleMatch.players).length;
}
function battleAlivePlayers() {
  return Object.values(battleMatch.players).filter(p => p.alive);
}
function currentSafeRadius() {
  if (!battleMatch.shrinkStartedAt) return BATTLE_MAX_RADIUS;
  const elapsed = Date.now() - battleMatch.shrinkStartedAt;
  const progress = Math.min(1, elapsed / BATTLE_SHRINK_DURATION_MS);
  return BATTLE_MAX_RADIUS - (BATTLE_MAX_RADIUS - BATTLE_MIN_RADIUS) * progress;
}

function broadcastBattleLobby() {
  io.emit('battleLobbyUpdate', {
    state: battleMatch.state,
    players: Object.values(battleMatch.players).map(p => ({ username: p.username, blookImage: p.blookImage })),
    minPlayers: BATTLE_MIN_PLAYERS,
    countdownEndsAt: battleMatch.countdownEndsAt
  });
}

function maybeStartCountdown() {
  if (battleMatch.state === 'waiting' && battlePlayerCount() >= BATTLE_MIN_PLAYERS) {
    battleMatch.state = 'countdown';
    battleMatch.countdownEndsAt = Date.now() + BATTLE_COUNTDOWN_MS;
    broadcastBattleLobby();
    setTimeout(() => {
      if (battleMatch.state === 'countdown') startBattleMatch();
    }, BATTLE_COUNTDOWN_MS);
  }
}

function startBattleMatch() {
  if (battlePlayerCount() < BATTLE_MIN_PLAYERS) {
    battleMatch.state = 'waiting';
    battleMatch.countdownEndsAt = null;
    broadcastBattleLobby();
    return;
  }

  battleMatch.state = 'active';
  battleMatch.shrinkStartedAt = Date.now();

  const players = Object.values(battleMatch.players);
  players.forEach((p, i) => {
    const angle = (i / players.length) * Math.PI * 2;
    p.x = BATTLE_CENTER.x + Math.cos(angle) * (BATTLE_MAX_RADIUS * 0.6);
    p.y = BATTLE_CENTER.y + Math.sin(angle) * (BATTLE_MAX_RADIUS * 0.6);
    p.hp = BATTLE_START_HP;
    p.alive = true;
    p.dirX = 0;
    p.dirY = 0;
  });

  io.emit('battleMatchStarted', {
    players: players.map(p => ({ username: p.username, blookImage: p.blookImage, x: p.x, y: p.y })),
    arenaSize: BATTLE_ARENA_SIZE,
    center: BATTLE_CENTER
  });

  battleTickInterval = setInterval(battleTick, BATTLE_TICK_MS);
}

function eliminatePlayer(key) {
  const p = battleMatch.players[key];
  if (!p || !p.alive) return;
  p.alive = false;
  p.hp = 0;
  battleMatch.eliminationOrder.push(p.username);
}

function battleTick() {
  const radius = currentSafeRadius();

  Object.entries(battleMatch.players).forEach(([key, p]) => {
    if (!p.alive) return;

    p.x = Math.max(0, Math.min(BATTLE_ARENA_SIZE, p.x + p.dirX * BATTLE_MOVE_SPEED));
    p.y = Math.max(0, Math.min(BATTLE_ARENA_SIZE, p.y + p.dirY * BATTLE_MOVE_SPEED));

    const dist = Math.hypot(p.x - BATTLE_CENTER.x, p.y - BATTLE_CENTER.y);
    if (dist > radius) {
      p.hp -= BATTLE_ZONE_DAMAGE_PER_TICK;
      if (p.hp <= 0) eliminatePlayer(key);
    }
  });

  const alive = battleAlivePlayers();

  io.emit('battleState', {
    radius,
    players: Object.values(battleMatch.players).map(p => ({
      username: p.username, x: p.x, y: p.y, hp: Math.max(0, p.hp), alive: p.alive
    }))
  });

  if (alive.length <= 1) {
    endBattleMatch(alive.length === 1 ? alive[0].username : null);
  }
}

function endBattleMatch(winnerUsername) {
  clearInterval(battleTickInterval);
  battleTickInterval = null;
  battleMatch.state = 'ended';
  battleMatch.winner = winnerUsername;

  const placements = winnerUsername
    ? [winnerUsername, ...battleMatch.eliminationOrder.slice().reverse()]
    : battleMatch.eliminationOrder.slice().reverse();

  const results = placements.map((username, idx) => {
    const place = idx + 1;
    const reward = BATTLE_REWARDS[place] || BATTLE_DEFAULT_REWARD;
    const user = db.users[username.toLowerCase()];
    if (user) {
      user.tokens += reward;
    }
    return { username, place, reward };
  });
  saveDB();
  battleMatch.resultsPlacements = results;

  io.emit('battleEnded', { winner: winnerUsername, results });

  setTimeout(() => {
    battleMatch = freshBattleLobby();
    broadcastBattleLobby();
  }, BATTLE_RESULTS_DISPLAY_MS);
}

function battleHandleDisconnectOrLeave(username) {
  if (!username) return;
  const key = username.toLowerCase();
  if (!battleMatch.players[key]) return;

  if (battleMatch.state === 'waiting' || battleMatch.state === 'countdown') {
    delete battleMatch.players[key];
    if (battlePlayerCount() < BATTLE_MIN_PLAYERS && battleMatch.state === 'countdown') {
      battleMatch.state = 'waiting';
      battleMatch.countdownEndsAt = null;
    }
    broadcastBattleLobby();
  } else if (battleMatch.state === 'active') {
    eliminatePlayer(key);
    const alive = battleAlivePlayers();
    if (alive.length <= 1) {
      endBattleMatch(alive.length === 1 ? alive[0].username : null);
    }
  }
}

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const key = userKeyForToken(token);
  const user = key && db.users[key];
  socket.data.ipHash = hashIP(socketIP(socket));
  if (isIPBanned(socket.data.ipHash) && !isStaff(user)) return next(new Error('banned'));
  socket.data.userKey = key;
  next();
});

function socketUser(socket) {
  const key = socket.data.userKey;
  if (!key) return null;
  const user = own(db.users, key);
  if (!user || isBanned(user)) {
    socket.data.userKey = null;
    onlineUsers.delete(socket.id);
    return null;
  }
  return user;
}

function isValidChatColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
}

io.on('connection', (socket) => {
  socket.on('registerUser', () => {
    const user = socketUser(socket);
    if (!user) return;
    const key = user.username.toLowerCase();
    onlineUsers.set(socket.id, user.username);
    broadcastUserCount();

    socket.rooms.forEach(r => { if (r.startsWith('clan:')) socket.leave(r); });
    if (user.clanId && own(db.clans, user.clanId)) {
      socket.join('clan:' + user.clanId);
    }
    socket.join('user:' + key);
    cancelPendingRubyReset(key);
  });

  socket.on('chatMessage', (msg) => {
    const user = socketUser(socket);
    if (!user || user.muted || !msg) return;
    const username = user.username;
    const perks = false; // removed all perks anyways so this isnt even needed

    const entry = {
      id: Date.now() + Math.random(),
      user: username,
      text: String(msg.text || '').slice(0, 500),
      color: perks && isValidChatColor(msg.color) ? msg.color : null,
      glow: perks && !!msg.glow,
      timestamp: new Date().toISOString()
    };
    db.globalChat.push(entry);
    if (db.globalChat.length > 200) db.globalChat = db.globalChat.slice(-200);
    user.messagesSent = (user.messagesSent || 0) + 1;
    saveDB();

    io.emit('message', { ...entry, ...chatIdentityFor(username) });
  });

  socket.on('clanChatMessage', (msg) => {
    const user = socketUser(socket);
    if (!user || !msg || !user.clanId || !own(db.clans, user.clanId)) return;
    if (user.muted) return;

    const clan = db.clans[user.clanId];
    const entry = {
      id: Date.now() + Math.random(),
      author: user.username,
      text: String(msg.text || '').slice(0, 500),
      timestamp: new Date().toISOString()
    };
    clan.chat.push(entry);
    if (clan.chat.length > 200) clan.chat = clan.chat.slice(-200);
    user.messagesSent = (user.messagesSent || 0) + 1;
    saveDB();

    io.to('clan:' + user.clanId).emit('clanMessage', entry);
  });

  socket.on('tradeChatMessage', (msg) => {
    const user = socketUser(socket);
    if (!user || !msg) return;
    if (user.muted) return;

    const trade = db.trades.find(t => t.id === msg.tradeId);
    if (!trade) return;
    const key = user.username.toLowerCase();
    if (trade.fromKey !== key && trade.toKey !== key) return;

    const entry = {
      id: Date.now() + Math.random(),
      author: user.username,
      text: String(msg.text || '').slice(0, 500),
      timestamp: new Date().toISOString()
    };
    trade.chat.push(entry);
    if (trade.chat.length > 200) trade.chat = trade.chat.slice(-200);
    user.messagesSent = (user.messagesSent || 0) + 1;
    saveDB();

    io.to('user:' + trade.fromKey).to('user:' + trade.toKey).emit('tradeChatMessage', { tradeId: trade.id, message: entry });
  });

  socket.on('disconnect', () => {
    const disconnectedUsername = onlineUsers.get(socket.id);
    battleHandleDisconnectOrLeave(disconnectedUsername);
    onlineUsers.delete(socket.id);
    broadcastUserCount();

    if (disconnectedUsername) {
      const key = disconnectedUsername.toLowerCase();
      if (!isUserOnline(key)) {
        scheduleRubyResetIfOffline(key);
      }
    }
  });

  socket.on('battleJoinLobby', (data) => {
    const user = socketUser(socket);
    if (!user) return;
    const username = user.username;
    if (battleMatch.state !== 'waiting' && battleMatch.state !== 'countdown') return;

    const key = username.toLowerCase();
    if (battleMatch.players[key]) return;

    const blookImage = (data || {}).blookImage || null;
    let validatedImage = null;
    if (blookImage) {
      const owned = Object.entries(user.collection || {}).some(([itemKey, qty]) => {
        if (qty < 1) return false;
        const [packKey, name] = itemKey.split('::');
        const pack = own(PACK_CONFIGS, packKey);
        const blook = pack && pack.rates.find(r => r.name === name);
        return blook && blook.item === blookImage;
      });
      if (owned) validatedImage = blookImage;
    }

    battleMatch.players[key] = {
      username: user.username,
      blookImage: validatedImage,
      x: 0, y: 0, hp: BATTLE_START_HP, alive: true, dirX: 0, dirY: 0
    };
    broadcastBattleLobby();
    maybeStartCountdown();
  });

  socket.on('battleLeaveLobby', () => {
    const user = socketUser(socket);
    if (user) battleHandleDisconnectOrLeave(user.username);
  });

  socket.on('battleMove', (data) => {
    const user = socketUser(socket);
    if (!user || battleMatch.state !== 'active') return;
    const username = user.username;
    const p = battleMatch.players[username.toLowerCase()];
    if (!p || !p.alive) return;

    let dx = Number((data || {}).dx) || 0;
    let dy = Number((data || {}).dy) || 0;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) { dx = 0; dy = 0; }
    const mag = Math.hypot(dx, dy);
    if (mag > 1) { dx /= mag; dy /= mag; }
    p.dirX = dx;
    p.dirY = dy;
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/:page', (req, res, next) => {
  const page = req.params.page;

  if (!/^[A-Za-z0-9_-]+$/.test(page)) {
    return next();
  }

  const htmlPath = path.join(__dirname, 'public', `${page}.html`);

  if (fs.existsSync(htmlPath) && fs.statSync(htmlPath).isFile()) {
    return res.sendFile(htmlPath);
  }

  const files = fs.readdirSync(path.join(__dirname, 'public'));
  const match = files.find(file =>
    file.startsWith(`${page}.`) &&
    fs.statSync(path.join(__dirname, 'public', file)).isFile()
  );

  if (match) {
    return res.sendFile(path.join(__dirname, 'public', match));
  }

  next();
});

function shutdown() {
  saveDB();
  store.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  serverStarted = true;
  console.log(`running on http://localhost:${PORT}`);
});