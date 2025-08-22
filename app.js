var express = require('express');
var fs = require('fs');
var bodyParser = require('body-parser');
var request = require('request');
var path = require('path');
var open = require('open');

var app = express();
var downloadProgress = new Map();

// Add CORS support
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  next();
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// SSE endpoint for progress updates
app.get('/progress', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const clientId = Date.now();
  
  const keepAlive = setInterval(() => {
    res.write('data: {"type":"heartbeat"}\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });

  // Send current progress state
  const currentProgress = Array.from(downloadProgress.entries()).map(([id, data]) => ({
    id,
    ...data
  }));
  
  res.write(`data: ${JSON.stringify({type: 'init', progress: currentProgress})}\n\n`);

  // Store client for progress updates
  req.progressClient = true;
  req.clientId = clientId;
  app.progressClients = app.progressClients || [];
  app.progressClients.push({id: clientId, res: res});
});

function broadcastProgress(data) {
  if (app.progressClients) {
    app.progressClients.forEach(client => {
      try {
        client.res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (e) {
        // Client disconnected
      }
    });
  }
}

// Scan page resources endpoint
app.post('/scan', (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Missing URL parameter'
      });
    }
    
    request({
      url: url,
      rejectUnauthorized: false,
      timeout: 30000
    }, (error, response, body) => {
      if (error) {
        return res.json({
          success: false,
          error: error.message
        });
      }
      
      if (response.statusCode !== 200) {
        return res.json({
          success: false,
          error: `HTTP ${response.statusCode}`
        });
      }
      
      try {
        const resources = extractResources(body, url);
        const title = extractTitle(body, url);
        res.json({
          success: true,
          resources: resources,
          total: resources.length,
          title: title
        });
      } catch (e) {
        res.json({
          success: false,
          error: 'Failed to parse HTML'
        });
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

function extractTitle(html, fallbackUrl) {
  // Extract page title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  let title = titleMatch ? titleMatch[1].trim() : '';
  
  if (!title) {
    // Fallback to domain name
    try {
      const urlObj = new URL(fallbackUrl);
      title = urlObj.hostname.replace('www.', '');
    } catch (e) {
      title = 'download';
    }
  }
  
  // Clean title for directory name
  title = title
    .replace(/[<>:"/\\|?*]/g, '_')  // Replace invalid chars
    .replace(/\s+/g, '_')           // Replace spaces with underscores
    .replace(/_+/g, '_')            // Remove multiple underscores
    .replace(/^_|_$/g, '')          // Remove leading/trailing underscores
    .substring(0, 50);              // Limit length
  
  return title || 'download';
}

function extractResources(html, baseUrl) {
  const resources = [baseUrl]; // Include the page itself
  const urlObj = new URL(baseUrl);
  const baseOrigin = urlObj.origin;
  
  // Simple regex patterns to extract resources
  const patterns = [
    /<link[^>]+href=["']([^"']+)["'][^>]*>/gi,  // CSS files
    /<script[^>]+src=["']([^"']+)["'][^>]*>/gi, // JS files  
    /<img[^>]+src=["']([^"']+)["'][^>]*>/gi     // Images
  ];
  
  patterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      let resourceUrl = match[1];
      
      // Skip data URLs, javascript:, etc
      if (resourceUrl.startsWith('data:') || 
          resourceUrl.startsWith('javascript:') || 
          resourceUrl.startsWith('mailto:')) {
        continue;
      }
      
      // Convert relative URLs to absolute
      if (resourceUrl.startsWith('//')) {
        resourceUrl = urlObj.protocol + resourceUrl;
      } else if (resourceUrl.startsWith('/')) {
        resourceUrl = baseOrigin + resourceUrl;
      } else if (!resourceUrl.startsWith('http')) {
        try {
          resourceUrl = new URL(resourceUrl, baseUrl).href;
        } catch (e) {
          continue;
        }
      }
      
      // Only include HTTP/HTTPS URLs
      if (resourceUrl.startsWith('http')) {
        resources.push(resourceUrl);
      }
    }
  });
  
  // Remove duplicates
  return [...new Set(resources)];
}

app.post('/download', (req, res) => {
  try {
    var data = req.body;
    
    if (!data || (!data.urls && !data.filepaths)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: urls'
      });
    }
    
    var urls = data.urls || data.filepaths;
    var dirPath = data.dirPath || 'downloads/';
    
    if (typeof urls === 'string') {
      urls = urls.split('\n').filter(url => url.trim());
    }
    
    if (!Array.isArray(urls)) {
      urls = [urls];
    }
    
    urls = urls.filter(url => url && url.trim()).map(url => url.trim());
    
    const taskId = Date.now().toString();
    const taskData = {
      total: urls.length,
      completed: 0,
      failed: 0,
      status: 'downloading',
      files: []
    };
    
    downloadProgress.set(taskId, taskData);
    
    var fileDirPath = path.join(__dirname, './static/', dirPath);
    if (!fs.existsSync(fileDirPath)) {
      fs.mkdirSync(fileDirPath, { recursive: true });
    }
    
    broadcastProgress({
      type: 'start',
      taskId: taskId,
      total: urls.length,
      dirPath: dirPath
    });
    
    urls.forEach((url, index) => {
      setTimeout(() => {
        downloadFile(url, fileDirPath, taskId, index);
      }, index * 100); // Stagger downloads slightly
    });
    
    res.json({ 
      success: true, 
      message: 'Download task started', 
      taskId: taskId,
      totalUrls: urls.length,
      targetDir: dirPath
    });
    
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({
      success: false,
      error: 'Server error: ' + error.message
    });
  }
});

function downloadFile(url, basePath, taskId, index) {
  const taskData = downloadProgress.get(taskId);
  if (!taskData) return;
  
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    const cleanPath = urlObj.pathname;
    
    const lastIndex = cleanPath.lastIndexOf('/');
    let fileName = cleanPath.substr(lastIndex + 1);
    const dirPath = cleanPath.substr(0, lastIndex);
    
    // If no filename or ends with /, treat as HTML page
    if (!fileName || fileName === '' || cleanPath.endsWith('/')) {
      fileName = 'index.html';
    }
    
    const safeFileName = fileName.replace(/[<>:"/\\|?*]/g, '_');
    const fullDirPath = path.join(basePath, hostname + dirPath);
    
    if (!fs.existsSync(fullDirPath)) {
      fs.mkdirSync(fullDirPath, { recursive: true });
    }
    
    const filePath = path.join(fullDirPath, safeFileName);
    const stream = fs.createWriteStream(filePath);
    
    broadcastProgress({
      type: 'progress',
      taskId: taskId,
      index: index,
      fileName: safeFileName,
      status: 'downloading'
    });
    
    const req = request({
      url: url,
      rejectUnauthorized: false, // Ignore SSL certificate errors
      timeout: 30000 // 30 second timeout
    });
    
    req.on('error', (err) => {
      updateProgress(taskId, index, 'failed', err.message);
    });
    
    req.on('response', (response) => {
      if (response.statusCode !== 200) {
        updateProgress(taskId, index, 'failed', `HTTP ${response.statusCode}`);
        return;
      }
    });
    
    req.pipe(stream).on('close', () => {
      updateProgress(taskId, index, 'completed', safeFileName);
    });
    
    stream.on('error', (err) => {
      updateProgress(taskId, index, 'failed', err.message);
    });
    
  } catch (error) {
    updateProgress(taskId, index, 'failed', error.message);
  }
}

function updateProgress(taskId, index, status, info) {
  const taskData = downloadProgress.get(taskId);
  if (!taskData) return;
  
  if (status === 'completed') {
    taskData.completed++;
  } else if (status === 'failed') {
    taskData.failed++;
  }
  
  taskData.files[index] = { status, info };
  
  const isComplete = (taskData.completed + taskData.failed) >= taskData.total;
  if (isComplete) {
    taskData.status = 'completed';
  }
  
  broadcastProgress({
    type: 'update',
    taskId: taskId,
    index: index,
    status: status,
    info: info,
    completed: taskData.completed,
    failed: taskData.failed,
    total: taskData.total,
    isComplete: isComplete
  });
  
  if (isComplete) {
    setTimeout(() => downloadProgress.delete(taskId), 30000);
  }
}

app.use('/', express.static('./static'));

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://127.0.0.1:${PORT}`);
  console.log('Opening desktop interface...');
  open(`http://127.0.0.1:${PORT}/app.html`);
});