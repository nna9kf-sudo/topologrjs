window.addEventListener("load", () => {
  const container = document.getElementById("topology-container");
  if (!container) return;

  const canvas = document.createElement("canvas");
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  // Forces strict size boundaries even if parent layouts collapse to 0
  function resizeCanvas() {
    const parentWidth = container.clientWidth;
    const parentHeight = container.clientHeight;
    
    // Fallback directly to window viewport sizes if the parent wrapper size is missing
    canvas.width = parentWidth > 100 ? parentWidth : window.innerWidth;
    canvas.height = parentHeight > 100 ? parentHeight : window.innerHeight;
    
    if (canvas.height < 300) canvas.height = 600; // Hard minimum limit to protect canvas space
  }
  resizeCanvas();
  
  window.addEventListener("resize", () => {
    resizeCanvas();
    centerGraphOnCanvas();
  });

  let nodes = [], links = [], draggedNode = null, isPanning = false;
  let transform = { x: 100, y: 100, scale: 0.6 }; // Safe manual starting offsets
  let panStart = { x: 0, y: 0 }, hasCenteredOnStart = false;

  function getCallsignColor(id) {
    if (!id) return "#3b82f6";
    const cleanId = id.toString().toUpperCase().split(/[-_\s]/)[0];
    let hash = 0;
    for (let i = 0; i < cleanId.length; i++) {
      hash = cleanId.charCodeAt(i) + ((hash << 5) - hash);
    }
    return `hsl(${Math.abs(hash) % 360}, 75%, 45%)`;
  }

  function initializeGraph() {
    const nodeMap = new Map();
    const linksData = window.topologyLinks || [];
    const savedLayout = window.initialLayout || {};
    
    links = linksData.map(l => ({ ...l }));

    linksData.forEach(link => {
      [link.from, link.to].forEach(id => {
        if (id && !nodeMap.has(id)) {
          const lY = savedLayout[id] || {};
          nodeMap.set(id, {
            id: id,
            x: lY.x !== undefined && !isNaN(lY.x) ? parseFloat(lY.x) : (Math.random() - 0.5) * 400,
            y: lY.y !== undefined && !isNaN(lY.y) ? parseFloat(lY.y) : (Math.random() - 0.5) * 400,
            vx: 0, vy: 0, 
            isPinned: !!lY.isPinned,
            radius: id.toUpperCase().includes("KO0OOO") ? 15 : 10
          });
        }
      });
    });

    nodes = Array.from(nodeMap.values());
    links.forEach(l => { 
      l.sourceNode = nodeMap.get(l.from); 
      l.targetNode = nodeMap.get(l.to); 
    });
  }

  function centerGraphOnCanvas() {
    if (!nodes.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach(n => {
      if(isNaN(n.x) || isNaN(n.y)) return;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    });

    const graphW = maxX - minX;
    const graphH = maxY - minY;
    
    // Strict protection variables against zero coordinate loops
    if (graphW <= 0 || graphH <= 0 || minX === Infinity || minY === Infinity) {
      transform.x = canvas.width / 2;
      transform.y = canvas.height / 2;
      transform.scale = 0.8;
      return;
    }

    const sX = (canvas.width * 0.75) / graphW;
    const sY = ((canvas.height - 80) * 0.75) / graphH;
    
    transform.scale = Math.min(Math.max(Math.min(sX, sY), 0.2), 1.2);
    transform.x = canvas.width / 2 - (minX + graphW / 2) * transform.scale;
    transform.y = (canvas.height + 60) / 2 - (minY + graphH / 2) * transform.scale;
  }

  function updatePhysics() {
    if (!nodes.length) return;
    const k = 0.04, repulse = 500, damp = 0.80;

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        if (dx === 0) dx = 0.1;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if (dist < 300) {
          const force = repulse / (dist * dist);
          const fx = force * (dx / dist);
          const fy = force * (dy / dist);
          if (!nodes[i].isPinned) { nodes[i].vx -= fx; nodes[i].vy -= fy; }
          if (!nodes[j].isPinned) { nodes[j].vx += fx; nodes[j].vy += fy; }
        }
      }
    }

    links.forEach(l => {
      if (!l.sourceNode || !l.targetNode) return;
      const dx = l.targetNode.x - l.sourceNode.x;
      const dy = l.targetNode.y - l.sourceNode.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - 130) * k;
      const fx = force * (dx / dist);
      const fy = force * (dy / dist);
      if (!l.sourceNode.isPinned) { l.sourceNode.vx += fx; l.sourceNode.vy += fy; }
      if (!l.targetNode.isPinned) { l.targetNode.vx -= fx; l.targetNode.vy -= fy; }
    });

    let activeM = 0;
    nodes.forEach(n => {
      if (n.isPinned) return;
      n.vx -= n.x * 0.004; 
      n.vy -= n.y * 0.004;
      n.x += n.vx; 
      n.y += n.vy; 
      activeM += Math.abs(n.vx) + Math.abs(n.vy);
      n.vx *= damp; 
      n.vy *= damp;
    });

    if (!hasCenteredOnStart && activeM < 0.4) {
      centerGraphOnCanvas(); 
      hasCenteredOnStart = true;
    }
  }

  function render() {
    // Safety check to clear the context completely
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.save(); 
    ctx.translate(transform.x, transform.y); 
    ctx.scale(transform.scale, transform.scale);

    // 1. Render Connections Lines
    links.forEach(l => {
      if (!l.sourceNode || !l.targetNode) return;
      ctx.beginPath(); 
      ctx.moveTo(l.sourceNode.x, l.sourceNode.y); 
      ctx.lineTo(l.targetNode.x, l.targetNode.y);
      const etx = parseFloat(l.pcost || 1);
      ctx.strokeStyle = etx > 4.5 ? "rgba(148, 163, 184, 0.45)" : "rgba(100, 116, 139, 0.8)";
      ctx.lineWidth = Math.max(0.8, 4.0 / etx); 
      ctx.stroke();
    });

    // 2. Render Node Circles & Call Sign text
    nodes.forEach(n => {
      const color = getCallsignColor(n.id);
      ctx.beginPath(); 
      ctx.arc(n.x, n.y, n.radius, 0, 2 * Math.PI);
      if (n.id && n.id.toUpperCase().includes("KO0OOO")) { 
        ctx.shadowBlur = 12; 
        ctx.shadowColor = color; 
      }
      ctx.fillStyle = color; 
      ctx.fill(); 
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#1e293b"; 
      ctx.lineWidth = 1.5; 
      ctx.stroke();

      ctx.font = "10px sans-serif"; 
      ctx.fillStyle = "#0f172a"; 
      ctx.textAlign = "center";
      ctx.fillText(n.id || "", n.x, n.y - n.radius - 5);
    });
    ctx.restore();

    // 3. Render Independent Top Banner Space
    const bannerHeight = 60;
    ctx.fillStyle = "rgba(30, 41, 59, 0.98)"; 
    ctx.fillRect(0, 0, canvas.width, bannerHeight);
    ctx.fillStyle = "#3b82f6"; 
    ctx.fillRect(0, bannerHeight - 2, canvas.width, 2);
    
    ctx.font = "bold 20px monospace, sans-serif"; 
    ctx.fillStyle = "#f8fafc"; 
    ctx.textAlign = "center"; 
    ctx.textBaseline = "middle";
    ctx.fillText("TOPOLOGY MAP OF THE GREATER LAS VEGAS MESH NETWORK", canvas.width / 2, bannerHeight / 2);
  }

  function loop() { 
    try {
      if (!draggedNode) updatePhysics(); 
      render(); 
    } catch(err) {
      console.error("Render execution trace paused:", err);
    }
    requestAnimationFrame(loop); 
  }

  function toScreenSpace(clientX, clientY) { 
    const r = canvas.getBoundingClientRect(); 
    return { 
      x: (clientX - r.left - transform.x) / transform.scale, 
      y: (clientY - r.top - transform.y) / transform.scale 
    }; 
  }

  canvas.addEventListener("mousedown", (e) => {
    const rect = canvas.getBoundingClientRect();
    if ((e.clientY - rect.top) <= 60) return;
    
    const mouse = toScreenSpace(e.clientX, e.clientY);
    draggedNode = nodes.find(n => Math.sqrt((n.x - mouse.x)**2 + (n.y - mouse.y)**2) < (n.radius + 6)) || null;
    
    if (draggedNode) {
      draggedNode.isPinned = true;
      draggedNode.vx = 0; draggedNode.vy = 0;
    } else { 
      isPanning = true; 
      panStart.x = e.clientX - transform.x; 
      panStart.y = e.clientY - transform.y; 
    }
  });

  canvas.addEventListener("mousemove", (e) => {
    if (draggedNode) { 
      const mouse = toScreenSpace(e.clientX, e.clientY); 
      draggedNode.x = mouse.x; draggedNode.y = mouse.y; 
      draggedNode.vx = 0; draggedNode.vy = 0;
    } else if (isPanning) { 
      transform.x = e.clientX - panStart.x; 
      transform.y = e.clientY - panStart.y; 
    }
  });

  window.addEventListener("mouseup", () => {
    if (draggedNode) {
      const payload = { nodeId: draggedNode.id, x: draggedNode.x, y: draggedNode.y, isPinned: true };
      fetch("/save-layout", { 
        method: "POST", 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify(payload) 
      }).catch(() => {});
      draggedNode = null;
    }
    isPanning = false;
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault(); 
    const z = Math.exp((e.deltaY < 0 ? 1 : -1) * 0.08);
    const r = canvas.getBoundingClientRect();
    const mX = e.clientX - r.left, mY = e.clientY - r.top;
    transform.x = mX - (mX - transform.x) * z; 
    transform.y = mY - (mY - transform.y) * z; 
    transform.scale *= z;
  }, { passive: false });

  // Initialize structural components and run the engine loop
  initializeGraph(); 
  centerGraphOnCanvas(); // Force initial baseline position calculations instantly
  loop();
});
