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
  mods: {}
};

function loadState(){
  try{
    if(fs.existsSync(DATA_FILE)){
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      state.accounts = saved.accounts || {};
      state.servers = saved.servers || {};
      state.messages = saved.messages || {};
      state.mods = saved.mods || {};
    }
  }catch(e){
    console.error("Konnte server_data.json nicht lesen:", e.message);
  }
}

function saveState(){
  try{
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
  const frame = wsFrame({type:"state", state});
  for(const socket of Array.from(clients)){
    try{
      socket.write(frame);
    }catch(e){
      clients.delete(socket);
    }
  }
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
    sendJson(res, state);
    return;
  }

  if(req.url === "/api/accounts" && req.method === "POST"){
    const data = await readBody(req);
    if(data.accounts && typeof data.accounts === "object"){
      state.accounts = data.accounts;
      saveState();
      broadcastState();
    }
    sendJson(res, {ok:true});
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
    socket.write(wsFrame({type:"state", state}));
  }catch(e){}

  socket.on("close", ()=>clients.delete(socket));
  socket.on("error", ()=>clients.delete(socket));
});

server.listen(PORT, ()=>{
  console.log("Safinicraft.de läuft auf http://localhost:" + PORT);
});
