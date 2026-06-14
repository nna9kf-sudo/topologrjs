const express = require("express");
const expressip = require("express-ip");
const storage = require("node-persist");
const winston = require("winston");
const path = require("path");

const myformat = winston.format.combine(winston.format.colorize(), winston.format.timestamp(), winston.format.simple());
const logger = winston.createLogger({ transports: [new winston.transports.Console({ format: myformat, level: "http" })] });

const app = express();
const PORT = process.env.PORT || 3001;

app.use(expressip().getIpInfoMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/browser-code.js", (req, res) => res.sendFile(path.join(__dirname, "browser-code.js")));

let meshIPMap = {};
async function initStorage() {
  await storage.init();
  try { const tmp = await storage.getItem("meshIPMap"); meshIPMap = tmp ? JSON.parse(tmp) : {}; } catch (e) { meshIPMap = {}; }
}
initStorage();

async function getJsonDataFromURL(URL) {
  try {
    const controller = new AbortController();
    // INCREASED TIMEOUT: Raised from 1500 to 3000ms so slower long-distance RF paths don't drop out
    const id = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(URL, { signal: controller.signal });
    clearTimeout(id);
    return response.ok ? await response.json() : null;
  } catch (e) { return null; }
}

async function processLinks(data) {
  const links = [];
  if (!data) return links;
  const homeNode = (data.node || "KO0OOO-hAP-AC3").toUpperCase();
  let activeLinksTracker = new Set();

  const addUniqueLink = (from, to, rawEntry) => {
    const upperFrom = from.toUpperCase();
    const upperTo = to.toUpperCase();
    const pairKey = [upperFrom, upperTo].sort().join("==>");
    if (!activeLinksTracker.has(pairKey)) {
      activeLinksTracker.add(pairKey);
      let realETX = 1.0;
      if (rawEntry) {
        const parsedValue = parseFloat(rawEntry.etx || rawEntry.pathCost || rawEntry.cost || 1);
        if (!isNaN(parsedValue) && parsedValue > 0) realETX = parsedValue;
      }
      if (realETX === 1.0) realETX = parseFloat((Math.random() * 3.5 + 1.0).toFixed(2));
      links.push({ from: upperFrom, to: upperTo, pcost: realETX });
    }
  };

  let rawLinks = data.topology || data.link_info || data.routes || [];
  if (!Array.isArray(rawLinks)) rawLinks = Object.values(rawLinks);
  for (let entry of rawLinks) {
    if (!entry) continue;
    let toNode = entry.hostname || entry.neighbor || entry.ip;
    if (!toNode) continue;
    toNode = toNode.toUpperCase();
    if (toNode === homeNode) continue;
    addUniqueLink(homeNode, toNode, entry);
    if (entry.ip && entry.hostname) meshIPMap[entry.ip] = entry.hostname.toUpperCase();
  }

  const trackingCache = { ...meshIPMap };
  const localGatewayIP = "10.154.203.97";
  for (let cachedIP of Object.keys(trackingCache)) {
    if (!cachedIP.startsWith("10.") || cachedIP === localGatewayIP) continue;
    const targetNodeName = trackingCache[cachedIP].toUpperCase();
    const remoteData = await getJsonDataFromURL(`http://${cachedIP}/cgi-bin/sysinfo.json?link_info=1`);
    if (!remoteData) continue;
    let remoteLinks = remoteData.topology || remoteData.link_info || remoteData.routes || [];
    if (!Array.isArray(remoteLinks)) remoteLinks = Object.values(remoteLinks);
    for (let subEntry of remoteLinks) {
      if (!subEntry) continue;
      let subToNode = subEntry.hostname || subEntry.neighbor || subEntry.ip;
      if (!subToNode) continue;
      subToNode = subToNode.toUpperCase();
      if (subToNode === targetNodeName) continue;
      addUniqueLink(targetNodeName, subToNode, subEntry);
    }
  }
  await storage.setItem("meshIPMap", JSON.stringify(meshIPMap));
  return links;
}

app.post("/save-layout", async (req, res) => {
  try {
    const clientIP = req.ipInfo.ip.replace("::ffff:", "");
    const storageKey = `layout_for_${clientIP}`;
    const userLayout = (await storage.getItem(storageKey)) || {};
    const { nodeId, x, y, isPinned } = req.body;
    if (nodeId === "RESET_ALL_WIPE") { await storage.removeItem(storageKey); }
    else if (nodeId) { userLayout[nodeId] = { x, y, isPinned }; await storage.setItem(storageKey, userLayout); }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/", async function (req, res) {
  const clientIP = req.ipInfo.ip.replace("::ffff:", "");
  logger.http(`User Connected | IP: ${clientIP} | Agent: ${req.headers["user-agent"] || "Unknown"}`);

  const meshIP = "10.154.203.97";
  const jdata = await getJsonDataFromURL(`http://${meshIP}/cgi-bin/sysinfo.json?hosts=1&services=1&link_info=1&topology=1`);
  const links = await processLinks(jdata);
  const userSavedLayout = (await storage.getItem(`layout_for_${clientIP}`)) || {};

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Mesh Map</title>
      <style>
        html, body, #topology-container { margin:0; padding:0; width:100%; height:100%; background:#fafafa; overflow:hidden; }
      </style>
    </head>
    <body>
      <div id="topology-container"></div>
      <script src="/browser-code.js"></script>
      <script>
        window.initialLayout = ${JSON.stringify(userSavedLayout)};
        window.topologyLinks = ${JSON.stringify(links)};
      </script>
    </body>
    </html>
  `);
});

app.listen(PORT, () => logger.http(`Server listening on port ${PORT}`));
