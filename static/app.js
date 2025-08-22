// Batch URL Downloader - Frontend Logic
(function() {
    'use strict';
    
    // DOM elements
    const urlsInput = document.getElementById('urls');
    const dirPathInput = document.getElementById('dirPath');
    const scanResourcesCheckbox = document.getElementById('scanResources');
    const startBtn = document.getElementById('startBtn');
    const clearBtn = document.getElementById('clearBtn');
    const totalCount = document.getElementById('totalCount');
    const completedCount = document.getElementById('completedCount');
    const failedCount = document.getElementById('failedCount');
    const progressFill = document.getElementById('progressFill');
    const status = document.getElementById('status');
    const log = document.getElementById('log');
    
    // State
    let eventSource = null;
    let isDownloading = false;
    let currentTask = null;
    
    // Initialize
    init();
    
    function init() {
        connectSSE();
        bindEvents();
        updateUI();
    }
    
    function connectSSE() {
        if (eventSource) {
            eventSource.close();
        }
        
        eventSource = new EventSource('/progress');
        
        eventSource.onopen = function() {
            console.log('SSE connected');
        };
        
        eventSource.onmessage = function(event) {
            try {
                const data = JSON.parse(event.data);
                handleProgressUpdate(data);
            } catch (e) {
                console.error('Invalid SSE data:', e);
            }
        };
        
        eventSource.onerror = function() {
            console.error('SSE connection error');
            setTimeout(connectSSE, 5000); // Reconnect after 5s
        };
    }
    
    function handleProgressUpdate(data) {
        switch (data.type) {
            case 'init':
                // Handle initial state if any
                break;
                
            case 'start':
                currentTask = data.taskId;
                isDownloading = true;
                updateStats(0, 0, data.total);
                setStatus(`Starting download of ${data.total} files...`);
                logMessage(`Download started - Target: ${data.dirPath}`);
                updateUI();
                break;
                
            case 'progress':
                if (data.taskId === currentTask) {
                    logMessage(`Downloading: ${data.fileName}`, 'info');
                }
                break;
                
            case 'update':
                if (data.taskId === currentTask) {
                    updateStats(data.completed, data.failed, data.total);
                    
                    const fileName = data.info;
                    if (data.status === 'completed') {
                        logMessage(`✓ Completed: ${fileName}`, 'success');
                    } else if (data.status === 'failed') {
                        logMessage(`✗ Failed: ${fileName} (${data.info})`, 'error');
                    }
                    
                    if (data.isComplete) {
                        isDownloading = false;
                        currentTask = null;
                        setStatus(`Download complete - ${data.completed} success, ${data.failed} failed`);
                        updateUI();
                    }
                }
                break;
        }
    }
    
    function bindEvents() {
        startBtn.addEventListener('click', startDownload);
        clearBtn.addEventListener('click', clearAll);
        
        urlsInput.addEventListener('input', function() {
            const urls = getUrls();
            totalCount.textContent = urls.length;
        });
        
        // Auto-scan checkbox handler
        scanResourcesCheckbox.addEventListener('change', function() {
            if (this.checked) {
                dirPathInput.disabled = true;
                dirPathInput.placeholder = 'Auto: Page title will be used';
            } else {
                dirPathInput.disabled = false;
                dirPathInput.placeholder = 'downloads/';
            }
        });
        
        // Keyboard shortcuts
        document.addEventListener('keydown', function(e) {
            if (e.ctrlKey && e.key === 'Enter' && !isDownloading) {
                startDownload();
            } else if (e.key === 'Escape') {
                clearAll();
            }
        });
    }
    
    function getUrls() {
        return urlsInput.value
            .split('\n')
            .map(url => url.trim())
            .filter(url => url.length > 0);
    }
    
    function startDownload() {
        if (isDownloading) return;
        
        const urls = getUrls();
        const dirPath = dirPathInput.value.trim() || 'downloads/';
        const shouldScanResources = scanResourcesCheckbox.checked;
        
        if (urls.length === 0) {
            alert('Please enter at least one URL');
            urlsInput.focus();
            return;
        }
        
        // Validate URLs
        const invalidUrls = urls.filter(url => {
            try {
                new URL(url);
                return false;
            } catch (e) {
                return true;
            }
        });
        
        if (invalidUrls.length > 0) {
            alert(`Invalid URLs found:\n${invalidUrls.slice(0, 3).join('\n')}${invalidUrls.length > 3 ? '\n...' : ''}`);
            return;
        }
        
        if (shouldScanResources) {
            scanAndDownload(urls, dirPath);
        } else {
            directDownload(urls, dirPath);
        }
    }
    
    function scanAndDownload(urls, dirPath) {
        setStatus('Scanning page resources...');
        clearLog();
        logMessage(`Scanning ${urls.length} pages for resources...`);
        
        let allResources = [];
        let pageTitle = '';
        let scannedCount = 0;
        
        urls.forEach((url, index) => {
            fetch('/scan', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url: url })
            })
            .then(response => response.json())
            .then(data => {
                scannedCount++;
                
                if (data.success) {
                    allResources = allResources.concat(data.resources);
                    // Use the first page's title as directory name
                    if (!pageTitle && data.title) {
                        pageTitle = data.title;
                    }
                    logMessage(`✓ Scanned: ${url} (${data.total} resources found)`);
                } else {
                    logMessage(`✗ Failed to scan: ${url} (${data.error})`, 'error');
                }
                
                if (scannedCount === urls.length) {
                    // Remove duplicates
                    allResources = [...new Set(allResources)];
                    // Use page title as directory name
                    const finalDirPath = pageTitle || extractDomainName(urls[0]) || 'download';
                    logMessage(`Scan complete - ${allResources.length} unique resources found`);
                    logMessage(`Directory: ${finalDirPath}`);
                    directDownload(allResources, finalDirPath + '/');
                }
            })
            .catch(error => {
                scannedCount++;
                logMessage(`✗ Scan error: ${url} (${error.message})`, 'error');
                
                if (scannedCount === urls.length) {
                    allResources = [...new Set(allResources)];
                    if (allResources.length > 0) {
                        const finalDirPath = pageTitle || extractDomainName(urls[0]) || 'download';
                        logMessage(`Proceeding with ${allResources.length} resources`);
                        logMessage(`Directory: ${finalDirPath}`);
                        directDownload(allResources, finalDirPath + '/');
                    } else {
                        setStatus('No resources to download');
                        logMessage('No valid resources found', 'error');
                    }
                }
            });
        });
    }
    
    function directDownload(urls, dirPath) {
        setStatus('Sending download request...');
        
        fetch('/download', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                urls: urls,
                dirPath: dirPath
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                logMessage(`Request sent - ${data.totalUrls} URLs queued`);
            } else {
                throw new Error(data.error || 'Request failed');
            }
        })
        .catch(error => {
            setStatus('Request failed: ' + error.message);
            logMessage(`Error: ${error.message}`, 'error');
        });
    }
    
    function clearAll() {
        urlsInput.value = '';
        dirPathInput.value = 'downloads/';
        updateStats(0, 0, 0);
        setStatus('Ready');
        clearLog();
        urlsInput.focus();
    }
    
    function updateStats(completed, failed, total) {
        totalCount.textContent = total;
        completedCount.textContent = completed;
        failedCount.textContent = failed;
        
        const progress = total > 0 ? ((completed + failed) / total) * 100 : 0;
        progressFill.style.width = progress + '%';
        
        // Color coding
        if (failed > 0) {
            progressFill.className = 'progress-fill error';
        } else if (completed > 0) {
            progressFill.className = 'progress-fill success';
        } else {
            progressFill.className = 'progress-fill';
        }
    }
    
    function setStatus(message) {
        status.textContent = message;
        console.log('Status:', message);
    }
    
    function logMessage(message, type = 'info') {
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        logEntry.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
        
        log.appendChild(logEntry);
        log.scrollTop = log.scrollHeight;
        
        // Keep only last 100 entries
        while (log.children.length > 100) {
            log.removeChild(log.firstChild);
        }
    }
    
    function clearLog() {
        log.innerHTML = '';
    }
    
    function updateUI() {
        startBtn.disabled = isDownloading;
        startBtn.textContent = isDownloading ? 'Downloading...' : 'Start Download';
        
        if (isDownloading) {
            startBtn.className = 'btn downloading';
        } else {
            startBtn.className = 'btn';
        }
    }
    
    function extractDomainName(url) {
        try {
            const urlObj = new URL(url);
            return urlObj.hostname.replace('www.', '').replace(/[<>:"/\\|?*]/g, '_');
        } catch (e) {
            return 'download';
        }
    }
    
    // Cleanup on page unload
    window.addEventListener('beforeunload', function() {
        if (eventSource) {
            eventSource.close();
        }
    });
    
})(); 