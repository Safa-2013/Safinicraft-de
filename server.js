const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "server_data.json");

let state = {
  accounts: {},
  servers: {},
  messages: {},
  mods: {},
  adminItems: {},
  worldSettings: {}
};

function encodePass(pass){
  return Buffer.from(String(pass || ""), "utf8").toString("base64");
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
  return (process.env.ADMIN_NAME || "admin").trim() || "admin";
}

function adminPassword(){
  return (process.env.ADMIN_PASSWORD || "admin").trim() || "admin";
}

function ensureAdmin(){
  state.accounts = state.accounts || {};
  const name = adminName();
  const pass = adminPassword();

  if(!state.accounts[name]){
    state.accounts[name] = {
      pass: encodePass(pass),
      role: "admin",
      skin: defaultSkin(),
      friends: [],
      friendRequests: [],
      sentRequests: [],
      gameInvites: [],
      unfriended: [],
      inv: {},
      created: Date.now(),
      online: false
    };
  }

  state.accounts[name].pass = encodePass(pass);
  state.accounts[name].role = "admin";
  if(!state.accounts[name].skin) state.accounts[name].skin = defaultSkin();
}

function sanitizeState(){
  ensureAdmin();
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
    }
  }catch(e){
    console.error("Konnte server_data.json nicht lesen:", e.message);
  }
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
    "Access-Control-Allow-Methods":"GET,POST,OPTIONS"
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
  Object.keys(incoming || {}).forEach(name=>{
    const inc = incoming[name] || {};
    const cur = state.accounts[name] || {};
    state.accounts[name] = {
      ...cur,
      ...inc,
      pass: cur.pass || inc.pass,
      role: cur.role || inc.role || "player"
    };
  });
  ensureAdmin();
}

loadState();

const server = http.createServer(async (req,res)=>{
  if(req.method === "OPTIONS"){
    res.writeHead(204, {
      "Access-Control-Allow-Origin":"*",
      "Access-Control-Allow-Headers":"Content-Type",
      "Access-Control-Allow-Methods":"GET,POST,OPTIONS"
    });
    res.end();
    return;
  }

  if(req.url === "/api/state" && req.method === "GET"){
    sendJson(res, sanitizeState());
    return;
  }

  if(req.url === "/api/login" && req.method === "POST"){
    const data = await readBody(req);
    const name = String(data.name || "").trim();
    const pass = String(data.pass || "");

    ensureAdmin();

    const acc = state.accounts[name];

    if(!acc || acc.pass !== encodePass(pass)){
      sendJson(res, {ok:false, error:"Name oder Passwort ist falsch."});
      return;
    }

    if(acc.banned){
      sendJson(res, {ok:false, error:"Dieser Spieler wurde gebannt."});
      return;
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
  console.log("Safinicraft.de PC/MOBILE CONTROL FIX 1.8.1 läuft auf Port " + PORT);
  console.log("ADMIN_NAME=" + adminName());
});
