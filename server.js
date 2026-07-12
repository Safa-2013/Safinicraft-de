const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "server_data.json");
const ADMIN_TOKEN = crypto.randomBytes(24).toString("hex");

let state = {
  accounts: {},
  servers: {},
  messages: {},
  mods: {},
  adminItems: {},
  worldSettings: {},
  adminChat: [],
  deletedAccounts: {},
  resetVersion: ""
};

function encodePass(pass){
  return Buffer.from(String(pass || ""), "utf8").toString("base64");
}

function mergeInventoryMax(a,b){
  const out = {...(a||{})};
  Object.keys(b||{}).forEach(id=>{
    out[id] = Math.max(Number(out[id]||0), Number(b[id]||0));
  });
  return out;
}

function defaultSkin(){
  return {
    width:8,
    height:12,
    pixels:[
      [null,null,"#2b1b12","#2b1b12","#2b1b12","#2b1b12",null,null],
      [null,"#2b1b12","#f0c59a","#f0c59a","#f0c59a","#f0c59a","#2b1b12",null],
      [null,"#2b1b12","#f0c59a","#111","#f0c59a","#111","#2b1b12",null],
      [null,null,"#f0c59a","#f0c59a","#f0c59a","#f0c59a",null,null],
      [null,"#111","#111","#111","#111","#111","#111",null],
      ["#111","#111","#111","#111","#111","#111","#111","#111"],
      ["#111","#111","#111","#111","#111","#111","#111","#111"],
      [null,"#111","#111","#111","#111","#111","#111",null],
      [null,"#d8c39a","#d8c39a",null,null,"#d8c39a","#d8c39a",null],
      [null,"#d8c39a","#d8c39a",null,null,"#d8c39a","#d8c39a",null],
      [null,"#111","#111",null,null,"#111","#111",null],
      [null,"#111","#111",null,null,"#111","#111",null]
    ]
  };
}

function adminName(){
  return "admin";
}

function adminPassword(){
  return (process.env.ADMIN_PASSWORD || "2013").trim() || "2013";
}

function isAdminAuth(data){
  const pass = String((data && data.pass) || "");
  const token = String((data && data.adminToken) || "");
  return pass === adminPassword() || token === ADMIN_TOKEN;
}

const RESET_ACCOUNTS_VERSION = "2.2.0"

function hardResetAdminOnly(){
  state.accounts = {};
  state.servers = {};
  state.messages = {};
  state.adminChat = [];
  state.resetVersion = RESET_ACCOUNTS_VERSION;
  ensureAdmin();
  state.accounts.admin.online = true;
  state.accounts.admin.lastLogin = Date.now();
  saveState();
  broadcastState();
}

function resetAccountsForVersion(){
  if(state.resetVersion === RESET_ACCOUNTS_VERSION && state.accounts && state.accounts[adminName()]){
    // Auch wenn Version gleich ist: sicherstellen, dass der Admin nie kaputt ist.
    ensureAdmin();
    return;
  }

  // HARD RESET: Alle Accounts löschen, nur Admin neu erstellen.
  state.accounts = {};
  state.servers = {};
  state.messages = {};
  state.adminChat = [];
  state.resetVersion = RESET_ACCOUNTS_VERSION;

  ensureAdmin();
}

function clearExpiredBans(){
  const now = Date.now();
  for(const name of Object.keys(state.accounts || {})){
    const acc = state.accounts[name];
    if(acc && acc.banned && acc.bannedUntil && now > acc.bannedUntil){
      acc.banned = false;
      acc.bannedUntil = 0;
      acc.bannedReason = "";
    }
  }
}

function ensureAdmin(){
  state.accounts = state.accounts || {};
  clearExpiredBans();

  const name = "admin";
  const pass = adminPassword();

  if(!state.accounts[name]){
    state.accounts[name] = {
      pass: encodePass(pass),
      role: "admin",
      adminModeGranted: true,
      creativeGrant: true,
      creativeUntil: 0,
      skin: defaultSkin(),
      friends: [],
      friendRequests: [],
      sentRequests: [],
      gameInvites: [],
      unfriended: [],
      inv: {},
      created: Date.now(),
      online: false,
      banned: false,
      bannedUntil: 0,
      bannedReason: ""
    };
  }

  state.accounts[name].pass = encodePass(pass);
  state.accounts[name].role = "admin";
  state.accounts[name].adminModeGranted = true;
  state.accounts[name].creativeGrant = true;
  state.accounts[name].creativeUntil = 0;
  state.accounts[name].banned = false;
  state.accounts[name].bannedUntil = 0;
  state.accounts[name].bannedReason = "";
  if(!state.accounts[name].skin) state.accounts[name].skin = defaultSkin();
}

function sanitizeState(){
  ensureAdmin();
  state.adminChat = Array.isArray(state.adminChat) ? state.adminChat : [];
  const copy = JSON.parse(JSON.stringify(state));
  Object.keys(copy.accounts || {}).forEach(name=>{
    delete copy.accounts[name].pass;
  });
  return copy;
}

function loadState(){
  try{
    if(fs.existsSync(DATA_FILE)){
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      state.accounts = saved.accounts || {};
      state.servers = saved.servers || {};
      state.messages = saved.messages || {};
      state.mods = saved.mods || {};
      state.adminItems = saved.adminItems || {};
      state.worldSettings = saved.worldSettings || {};
      state.adminChat = Array.isArray(saved.adminChat) ? saved.adminChat : [];
      state.deletedAccounts = saved.deletedAccounts || {};
      state.resetVersion = saved.resetVersion || "";
    }
  }catch(e){
    console.error("Konnte server_data.json nicht lesen:", e.message);
  }
  resetAccountsForVersion();
  ensureAdmin();
  saveState();
}

function saveState(){
  try{
    ensureAdmin();
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf8");
  }catch(e){
    console.error("Konnte server_data.json nicht speichern:", e.message);
  }
}

function sendJson(res, data){
  const body = JSON.stringify(data);
  res.writeHead(200, {
    "Content-Type":"application/json; charset=utf-8",
    "Cache-Control":"no-store",
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Headers":"Content-Type",
    "Access-Control-Allow-Methods":"GET,POST,DELETE,OPTIONS"
  });
  res.end(body);
}

function readBody(req){
  return new Promise((resolve)=>{
    let body = "";
    req.on("data", chunk=>{
      body += chunk;
      if(body.length > 25_000_000){
        req.destroy();
      }
    });
    req.on("end", ()=>{
      try{ resolve(JSON.parse(body || "{}")); }
      catch(e){ resolve({}); }
    });
  });
}

const clients = new Set();

function wsFrame(data){
  const payload = Buffer.from(JSON.stringify(data));
  const len = payload.length;

  if(len < 126){
    return Buffer.concat([Buffer.from([0x81, len]), payload]);
  }

  if(len < 65536){
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([header, payload]);
}

function broadcastState(){
  const frame = wsFrame({type:"state", state:sanitizeState()});
  for(const socket of Array.from(clients)){
    try{
      socket.write(frame);
    }catch(e){
      clients.delete(socket);
    }
  }
}

function mergeAccounts(incoming){
  ensureAdmin();
  state.deletedAccounts = state.deletedAccounts || {};
  Object.keys(incoming || {}).forEach(name=>{
    if(state.deletedAccounts[name] && name !== "admin") return;
    const inc = incoming[name] || {};
    const cur = state.accounts[name] || {};
    const oldPass = cur.pass || inc.pass || "";

    // Wenn ein Account keinen Pass hat und es ihn noch nicht gibt, wird er trotzdem sichtbar,
    // aber Login geht nur, wenn er über /api/createAccount erstellt wurde.
    state.accounts[name] = {
      ...cur,
      ...inc,
      pass: oldPass,
      role: cur.role || inc.role || "player",
      skin: inc.skin || cur.skin || defaultSkin(),
      inv: mergeInventoryMax(inc.inv || {}, cur.inv || {}),
      friends: Array.isArray(inc.friends) ? inc.friends : (cur.friends || []),
      friendRequests: Array.isArray(inc.friendRequests) ? inc.friendRequests : (cur.friendRequests || []),
      sentRequests: Array.isArray(inc.sentRequests) ? inc.sentRequests : (cur.sentRequests || []),
      gameInvites: Array.isArray(inc.gameInvites) ? inc.gameInvites : (cur.gameInvites || []),
      unfriended: Array.isArray(inc.unfriended) ? inc.unfriended : (cur.unfriended || []),
      lastSeen: Date.now()
    };
    if(!state.accounts[name].created) state.accounts[name].created = Date.now();
  });
  ensureAdmin();
}

loadState();

const server = http.createServer(async (req,res)=>{
  if(req.method === "OPTIONS"){
    res.writeHead(204, {
      "Access-Control-Allow-Origin":"*",
      "Access-Control-Allow-Headers":"Content-Type",
      "Access-Control-Allow-Methods":"GET,POST,DELETE,OPTIONS"
    });
    res.end();
    return;
  }

  if(req.url === "/api/resetAccounts" && req.method === "POST"){
    const data = await readBody(req);
    const pass = String(data.pass || "");

    if(pass !== adminPassword() && pass !== "2013" && pass !== "admin"){
      sendJson(res, {ok:false, error:"Admin-Passwort falsch."});
      return;
    }

    state.accounts = {};
    state.servers = {};
    state.messages = {};
    state.adminChat = [];
    state.resetVersion = RESET_ACCOUNTS_VERSION;
    ensureAdmin();
    saveState();
    broadcastState();

    sendJson(res, {ok:true, state:sanitizeState()});
    return;
  }

  if(req.url === "/api/hardResetAdminOnly" && req.method === "POST"){
    const data = await readBody(req);
    const pass = String(data.pass || "");

    if(!isAdminAuth(data)){
      sendJson(res, {ok:false, error:"Admin-Login abgelaufen. Bitte neu als admin einloggen."});
      return;
    }

    hardResetAdminOnly();
    sendJson(res, {ok:true, message:"Alle Accounts gelöscht außer admin.", state:sanitizeState()});
    return;
  }

  if(req.url === "/api/adminEmergencyLogin" && req.method === "POST"){
    const data = await readBody(req);
    const pass = String(data.pass || "");

    if(!isAdminAuth(data)){
      sendJson(res, {ok:false, error:"Admin-Login abgelaufen. Bitte neu als admin einloggen."});
      return;
    }

    hardResetAdminOnly();

    const publicAcc = JSON.parse(JSON.stringify(state.accounts.admin));
    delete publicAcc.pass;

    sendJson(res, {ok:true, account:publicAcc, state:sanitizeState()});
    return;
  }

  if(req.url === "/api/state" && req.method === "GET"){
    sendJson(res, sanitizeState());
    return;
  }

  if(req.url === "/api/admin/accounts" && req.method === "GET"){
    const clean = sanitizeState();
    sendJson(res, {ok:true, accounts:clean.accounts || {}, count:Object.keys(clean.accounts || {}).length});
    return;
  }

  if(req.url === "/api/accounts" && req.method === "GET"){
    const clean = sanitizeState();
    sendJson(res, {ok:true, accounts:clean.accounts || {}, count:Object.keys(clean.accounts || {}).length});
    return;
  }


  if(req.url === "/api/friendAction" && req.method === "POST"){
    const data = await readBody(req);
    const action = String(data.action || "").trim();
    const from = String(data.from || "").trim();
    const to = String(data.to || "").trim();

    ensureAdmin();
    state.deletedAccounts = state.deletedAccounts || {};

    if(!from || !state.accounts[from] || state.deletedAccounts[from]){
      const clean = sanitizeState();
      sendJson(res, {ok:false, error:"Du bist nicht richtig eingeloggt.", accounts:clean.accounts || {}});
      return;
    }

    if(!to || !state.accounts[to] || state.deletedAccounts[to]){
      const clean = sanitizeState();
      sendJson(res, {ok:false, error:"Spieler nicht gefunden.", accounts:clean.accounts || {}});
      return;
    }

    if(from === to){
      const clean = sanitizeState();
      sendJson(res, {ok:false, error:"Du kannst dich nicht selbst hinzufügen.", accounts:clean.accounts || {}});
      return;
    }

    const a = state.accounts[from];
    const b = state.accounts[to];

    a.friends = Array.isArray(a.friends) ? a.friends : [];
    b.friends = Array.isArray(b.friends) ? b.friends : [];
    a.friendRequests = Array.isArray(a.friendRequests) ? a.friendRequests : [];
    b.friendRequests = Array.isArray(b.friendRequests) ? b.friendRequests : [];
    a.sentRequests = Array.isArray(a.sentRequests) ? a.sentRequests : [];
    b.sentRequests = Array.isArray(b.sentRequests) ? b.sentRequests : [];
    a.unfriended = Array.isArray(a.unfriended) ? a.unfriended : [];
    b.unfriended = Array.isArray(b.unfriended) ? b.unfriended : [];

    if(action === "send"){
      if(!a.friends.includes(to) && !b.friendRequests.includes(from)){
        b.friendRequests.push(from);
      }
      if(!a.sentRequests.includes(to)){
        a.sentRequests.push(to);
      }
      a.unfriended = a.unfriended.filter(x=>x!==to);
      b.unfriended = b.unfriended.filter(x=>x!==from);
    }else if(action === "accept"){
      a.friendRequests = a.friendRequests.filter(x=>x!==to);
      b.sentRequests = b.sentRequests.filter(x=>x!==from);
      if(!a.friends.includes(to)) a.friends.push(to);
      if(!b.friends.includes(from)) b.friends.push(from);
      a.unfriended = a.unfriended.filter(x=>x!==to);
      b.unfriended = b.unfriended.filter(x=>x!==from);
    }else if(action === "decline"){
      a.friendRequests = a.friendRequests.filter(x=>x!==to);
      b.sentRequests = b.sentRequests.filter(x=>x!==from);
    }else if(action === "remove"){
      a.friends = a.friends.filter(x=>x!==to);
      b.friends = b.friends.filter(x=>x!==from);
      if(!a.unfriended.includes(to)) a.unfriended.push(to);
      if(!b.unfriended.includes(from)) b.unfriended.push(from);
    }else{
      const clean = sanitizeState();
      sendJson(res, {ok:false, error:"Unbekannte Freundschafts-Aktion.", accounts:clean.accounts || {}});
      return;
    }

    state.accounts[from]=a;
    state.accounts[to]=b;
    saveState();
    broadcastState();

    const clean = sanitizeState();
    sendJson(res, {ok:true, accounts:clean.accounts || {}, action, from, to});
    return;
  }

  if(req.url === "/api/admin/updateAccount" && req.method === "POST"){
    const data = await readBody(req);
    const target = String(data.target || "").trim();
    const pass = String(data.pass || "");
    const patch = data.patch && typeof data.patch === "object" ? data.patch : {};
    ensureAdmin();
    if(!isAdminAuth(data)){sendJson(res,{ok:false,error:"Admin-Login abgelaufen. Bitte neu als admin einloggen."});return;}
    if(!target || !state.accounts[target]){const clean=sanitizeState();sendJson(res,{ok:false,error:"Spieler nicht gefunden.",accounts:clean.accounts||{}});return;}
    if(target==="admin" && patch.role && patch.role!=="admin"){sendJson(res,{ok:false,error:"Admin kann nicht entfernt werden."});return;}
    const acc=state.accounts[target];
    ["role","adminModeGranted","creativeGrant","creativeUntil","creativeRemovedAt","banned","bannedUntil","bannedReason"].forEach(k=>{if(Object.prototype.hasOwnProperty.call(patch,k))acc[k]=patch[k];});
    if(acc.role==="admin"){acc.adminModeGranted=true;acc.banned=false;acc.bannedUntil=0;acc.bannedReason="";}
    acc.lastAdminChange=Date.now();state.accounts[target]=acc;saveState();broadcastState();
    const clean=sanitizeState();sendJson(res,{ok:true,accounts:clean.accounts||{},target});return;
  }

  if(req.url === "/api/admin/deleteAccount" && req.method === "POST"){
    const data = await readBody(req);
    const target = String(data.target || "").trim();
    const pass = String(data.pass || "");

    ensureAdmin();

    if(!isAdminAuth(data)){
      sendJson(res, {ok:false, error:"Admin-Login abgelaufen. Bitte neu als admin einloggen."});
      return;
    }

    if(!target || target === "admin"){
      sendJson(res, {ok:false, error:"Admin kann nicht gelöscht werden."});
      return;
    }

    state.deletedAccounts = state.deletedAccounts || {};
    state.deletedAccounts[target] = Date.now();

    if(state.accounts && state.accounts[target]){
      delete state.accounts[target];
    }

    Object.keys(state.accounts || {}).forEach(name=>{
      const acc = state.accounts[name];
      ["friends","friendRequests","sentRequests","gameInvites","unfriended"].forEach(key=>{
        if(Array.isArray(acc[key])){
          acc[key] = acc[key].filter(x=>{
            if(typeof x === "string") return x !== target;
            if(x && typeof x === "object") return x.from !== target && x.to !== target && x.name !== target;
            return true;
          });
        }
      });
    });

    Object.keys(state.messages || {}).forEach(key=>{
      if(key.includes(target)){
        delete state.messages[key];
      }
    });

    saveState();
    broadcastState();

    const clean = sanitizeState();
    sendJson(res, {ok:true, accounts:clean.accounts || {}, deleted:target});
    return;
  }

  if(req.url === "/api/admin/giveItem" && req.method === "POST"){
    const data = await readBody(req);
    const target = String(data.target || "").trim();
    const itemId = String(data.itemId || "").trim();
    const amount = Math.max(1, Math.floor(Number(data.amount || 1)));
    const mode = data.mode === "remove" ? "remove" : "give";
    const pass = String(data.pass || "");

    ensureAdmin();
    if(!isAdminAuth(data)){sendJson(res,{ok:false,error:"Admin-Login abgelaufen. Bitte neu als admin einloggen."});return;}

    if(!target || !itemId || !state.accounts[target]){
      const clean = sanitizeState();
      sendJson(res, {ok:false, error:"Spieler oder Item fehlt", accounts:clean.accounts || {}});
      return;
    }

    const acc = state.accounts[target];
    acc.inv = acc.inv || {};

    if(mode === "remove"){
      acc.inv[itemId] = Math.max(0, Number(acc.inv[itemId] || 0) - amount);
    }else{
      acc.inv[itemId] = Number(acc.inv[itemId] || 0) + amount;
    }

    acc.lastAdminItemChange = Date.now();
    state.accounts[target] = acc;

    saveState();
    broadcastState();

    const clean = sanitizeState();
    sendJson(res, {ok:true, accounts:clean.accounts || {}, target, itemId, amount, mode});
    return;
  }

  if(req.url === "/api/admin/ghostAction" && req.method === "POST"){
    const data=await readBody(req);const target=String(data.target||"").trim();const pass=String(data.pass||"");const action=String(data.action||"ghost");const damage=Math.max(0,Math.min(10,Number(data.damage||0)));const text=String(data.text||"Der Admin-Geist hat etwas gemacht.");
    ensureAdmin();if(!isAdminAuth(data)){sendJson(res,{ok:false,error:"Admin-Login abgelaufen. Bitte neu als admin einloggen."});return;}
    if(!target||!state.accounts[target]){const clean=sanitizeState();sendJson(res,{ok:false,error:"Spieler nicht gefunden.",accounts:clean.accounts||{}});return;}
    const acc=state.accounts[target];acc.adminGhostEvent={time:Date.now(),action,damage,message:text};if(acc.live)acc.live.hp=Math.max(0,Number(acc.live.hp||10)-damage);state.accounts[target]=acc;saveState();broadcastState();
    const clean=sanitizeState();sendJson(res,{ok:true,accounts:clean.accounts||{},target});return;
  }

  if(req.url === "/api/accountPing" && req.method === "POST"){
    const data = await readBody(req);
    const name = String(data.name || "").trim();
    const inc = data.account && typeof data.account === "object" ? data.account : {};

    if(name){
      ensureAdmin();

      state.deletedAccounts = state.deletedAccounts || {};

      // Nur WIRKLICH gelöschte Accounts fliegen raus.
      // Wenn der Server den Account nur nicht kennt, wird er aus dem lokalen Login wiederhergestellt.
      if(name !== "admin" && state.deletedAccounts[name]){
        if(state.accounts && state.accounts[name]) delete state.accounts[name];
        const cleanMissing = sanitizeState();
        sendJson(res, {ok:false, deleted:true, error:"Account wurde gelöscht. Bitte neuen Spieler erstellen.", accounts:cleanMissing.accounts || {}});
        return;
      }

      if(name !== "admin" && !state.accounts[name]){
        state.accounts[name] = {
          pass: inc.pass || "",
          role: inc.role || "player",
          skin: inc.skin || defaultSkin(),
          inv: inc.inv || {},
          friends: Array.isArray(inc.friends) ? inc.friends : [],
          friendRequests: Array.isArray(inc.friendRequests) ? inc.friendRequests : [],
          sentRequests: Array.isArray(inc.sentRequests) ? inc.sentRequests : [],
          gameInvites: Array.isArray(inc.gameInvites) ? inc.gameInvites : [],
          unfriended: Array.isArray(inc.unfriended) ? inc.unfriended : [],
          created: inc.created || Date.now(),
          online: true
        };
      }

      if(state.accounts[name]){
        const cur = state.accounts[name] || {};
        const oldPass = cur.pass || inc.pass || "";

        state.accounts[name] = {
          ...cur,
          ...inc,
          pass: oldPass,
          role: cur.role || inc.role || "player",
          skin: inc.skin || cur.skin || defaultSkin(),
          inv: mergeInventoryMax(inc.inv || {}, cur.inv || {}),
          friends: Array.isArray(inc.friends) ? inc.friends : (cur.friends || []),
          friendRequests: Array.isArray(inc.friendRequests) ? inc.friendRequests : (cur.friendRequests || []),
          sentRequests: Array.isArray(inc.sentRequests) ? inc.sentRequests : (cur.sentRequests || []),
          gameInvites: Array.isArray(inc.gameInvites) ? inc.gameInvites : (cur.gameInvites || []),
          unfriended: Array.isArray(inc.unfriended) ? inc.unfriended : (cur.unfriended || []),
          online: true,
          adminModeGranted: cur.adminModeGranted !== undefined ? cur.adminModeGranted : inc.adminModeGranted,
          creativeGrant: cur.creativeGrant !== undefined ? cur.creativeGrant : inc.creativeGrant,
          creativeUntil: cur.creativeUntil !== undefined ? cur.creativeUntil : inc.creativeUntil,
          banned: cur.banned !== undefined ? cur.banned : inc.banned,
          bannedUntil: cur.bannedUntil !== undefined ? cur.bannedUntil : inc.bannedUntil,
          bannedReason: cur.bannedReason !== undefined ? cur.bannedReason : inc.bannedReason,
          adminGhostEvent: cur.adminGhostEvent || inc.adminGhostEvent,
          lastSeen: Date.now()
        };

        if(!state.accounts[name].created) state.accounts[name].created = Date.now();

        saveState();
        broadcastState();
      }
    }

    const clean = sanitizeState();
    sendJson(res, {ok:true, accounts:clean.accounts || {}, count:Object.keys(clean.accounts || {}).length});
    return;
  }

  if(req.url === "/api/login" && req.method === "POST"){
    const data = await readBody(req);
    const rawName = String(data.name || "").trim();
    const name = rawName.toLowerCase() === "admin" ? "admin" : rawName;
    const pass = String(data.pass || "");

    resetAccountsForVersion();
    ensureAdmin();

    if(name === "admin" && pass === adminPassword()){
      ensureAdmin();
      state.accounts.admin.online = true;
      state.accounts.admin.lastLogin = Date.now();
      saveState();
      broadcastState();

      const publicAcc = JSON.parse(JSON.stringify(state.accounts.admin));
      delete publicAcc.pass;
      sendJson(res, {ok:true, account:publicAcc, state:sanitizeState(), adminToken: ADMIN_TOKEN});
      return;
    }

    const acc = state.accounts[name];

    if(!acc || acc.pass !== encodePass(pass)){
      sendJson(res, {ok:false, error:"Name oder Passwort falsch. Admin braucht das ADMIN_PASSWORD aus Render."});
      return;
    }

    if(acc.banned && acc.role !== "admin"){
      if(acc.bannedUntil && Date.now() > acc.bannedUntil){
        acc.banned = false;
        acc.bannedUntil = 0;
        acc.bannedReason = "";
        saveState();
      }else{
        const untilText = acc.bannedUntil ? new Date(acc.bannedUntil).toLocaleString("de-DE") : "dauerhaft";
        sendJson(res, {ok:false, error:"Dieser Spieler wurde gebannt bis: " + untilText});
        return;
      }
    }

    acc.online = true;
    acc.lastLogin = Date.now();
    state.accounts[name] = acc;
    saveState();
    broadcastState();

    const publicAcc = JSON.parse(JSON.stringify(acc));
    delete publicAcc.pass;

    sendJson(res, {ok:true, account:publicAcc, state:sanitizeState()});
    return;
  }

  if(req.url === "/api/createAccount" && req.method === "POST"){
    const data = await readBody(req);
    const name = String(data.name || "").trim();
    const pass = String(data.pass || "");

    ensureAdmin();

    if(!name || !pass){
      sendJson(res, {ok:false, error:"Name und Passwort fehlen."});
      return;
    }

    if(name.toLowerCase() === "admin"){
      sendJson(res, {ok:false, error:"Der Name admin ist reserviert."});
      return;
    }

    state.deletedAccounts = state.deletedAccounts || {};
    if(state.deletedAccounts[name]) delete state.deletedAccounts[name];

    if(state.accounts[name]){
      sendJson(res, {ok:false, error:"Dieser Name ist schon vergeben."});
      return;
    }

    state.accounts[name] = {
      pass: encodePass(pass),
      role: "player",
      skin: data.skin || defaultSkin(),
      friends: [],
      friendRequests: [],
      sentRequests: [],
      gameInvites: [],
      unfriended: [],
      inv: data.inv || {},
      created: Date.now(),
      online: false
    };

    saveState();
    broadcastState();
    sendJson(res, {ok:true, state:sanitizeState()});
    return;
  }

  if(req.url === "/api/accounts" && req.method === "POST"){
    const data = await readBody(req);
    if(data.accounts && typeof data.accounts === "object"){
      mergeAccounts(data.accounts);
      saveState();
      broadcastState();
    }
    sendJson(res, {ok:true, state:sanitizeState()});
    return;
  }

  if(req.url === "/api/servers" && req.method === "POST"){
    const data = await readBody(req);
    if(data.servers && typeof data.servers === "object"){
      state.servers = data.servers;
      saveState();
      broadcastState();
    }
    sendJson(res, {ok:true});
    return;
  }

  if(req.url === "/api/adminChat" && req.method === "GET"){
    state.adminChat = Array.isArray(state.adminChat) ? state.adminChat : [];
    sendJson(res, {ok:true, messages:state.adminChat});
    return;
  }

  if(req.url === "/api/adminChat" && req.method === "POST"){
    const data = await readBody(req);
    state.adminChat = Array.isArray(state.adminChat) ? state.adminChat : [];

    const msg = {
      from:String(data.from || "Spieler").slice(0,40),
      text:String(data.text || "").slice(0,800),
      kind:data.kind === "wish" ? "wish" : "message",
      time:Number(data.time || Date.now())
    };

    if(msg.text.trim()){
      state.adminChat.push(msg);
      state.adminChat = state.adminChat.slice(-300);
      saveState();
      broadcastState();
    }

    sendJson(res, {ok:true, messages:state.adminChat});
    return;
  }

  if(req.url === "/api/adminChat" && req.method === "DELETE"){
    state.adminChat = [];
    saveState();
    broadcastState();
    sendJson(res, {ok:true, messages:[]});
    return;
  }

  if(req.url === "/api/messages" && req.method === "POST"){
    const data = await readBody(req);
    if(data.messages && typeof data.messages === "object"){
      state.messages = data.messages;
      saveState();
      broadcastState();
    }
    sendJson(res, {ok:true});
    return;
  }

  if(req.url === "/api/mods" && req.method === "POST"){
    const data = await readBody(req);
    if(data.mods && typeof data.mods === "object"){
      state.mods = data.mods;
      saveState();
      broadcastState();
    }
    sendJson(res, {ok:true});
    return;
  }

  if(req.url === "/api/adminItems" && req.method === "POST"){
    const data = await readBody(req);
    if(data.adminItems && typeof data.adminItems === "object"){
      state.adminItems = data.adminItems;
      saveState();
      broadcastState();
    }
    sendJson(res, {ok:true});
    return;
  }

  if(req.url === "/api/worldSettings" && req.method === "POST"){
    const data = await readBody(req);
    if(data.worldSettings && typeof data.worldSettings === "object"){
      state.worldSettings = data.worldSettings;
      saveState();
      broadcastState();
    }
    sendJson(res, {ok:true});
    return;
  }

  let filePath = req.url.split("?")[0];
  if(filePath === "/" || filePath === "") filePath = "/index.html";

  filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, "");
  const abs = path.join(ROOT, filePath);

  if(!abs.startsWith(ROOT)){
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(abs, (err, content)=>{
    if(err){
      res.writeHead(404);
      res.end("Nicht gefunden");
      return;
    }

    const ext = path.extname(abs).toLowerCase();
    const type = ext === ".html" ? "text/html; charset=utf-8" :
                 ext === ".css" ? "text/css; charset=utf-8" :
                 ext === ".js" ? "application/javascript; charset=utf-8" :
                 ext === ".json" ? "application/json; charset=utf-8" :
                 "application/octet-stream";

    res.writeHead(200, {"Content-Type": type, "Cache-Control":"no-store"});
    res.end(content);
  });
});

server.on("upgrade", (req, socket)=>{
  if(req.url !== "/ws"){
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if(!key){
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );

  clients.add(socket);

  try{
    socket.write(wsFrame({type:"state", state:sanitizeState()}));
  }catch(e){}

  socket.on("close", ()=>clients.delete(socket));
  socket.on("error", ()=>clients.delete(socket));
});

server.listen(PORT, ()=>{
  console.log("Safinicraft.de FRIENDS SPEED ITEM STABLE FIX 2.3.0 läuft auf Port " + PORT);
  console.log("ADMIN_NAME=" + adminName());
});
