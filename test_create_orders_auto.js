const { BackpackClient } = require('./backpack_exchange-main/backpack_client');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const got = require('got');
const WebSocket = require('ws');

// 全局变量 - WebSocket相关
let priceWebSocket = null;
let wsConnected = false;
let wsReconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const WS_URL = 'wss://ws.backpack.exchange';
// 添加重连控制标志
let wsReconnecting = false;
// 添加变量控制价格更新显示频率
let lastPriceLogTime = 0;
let lastWebSocketPriceValue = 0;

// 添加全局变量，用于控制WebSocket日志输出
let wsLogControl = {
    lastLogTime: 0,
    logCount: 0,
    loggedThisCycle: false,
    cycleStartTime: 0
};

// 重置WebSocket日志控制参数
function resetWsLogControl() {
    wsLogControl.lastLogTime = Date.now();
    wsLogControl.logCount = 0;
    wsLogControl.loggedThisCycle = false;
}

// 日志函数
function log(message, isError = false, displayOnConsole = true) {
    const timestamp = new Date().toLocaleString();
    const logMessage = `[${timestamp}] ${message}`;
    
    // 只有当displayOnConsole为true时才在控制台显示
    if (displayOnConsole) {
        console.log(logMessage);
    }
    
    // 同时写入日志文件
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    
    const date = new Date().toISOString().split('T')[0];
    const logFile = path.join(logDir, `trading_${date}.log`);
    
    fs.appendFileSync(
        logFile, 
        logMessage + '\n', 
        { encoding: 'utf8' }
    );
    
    // 如果是错误，写入专门的错误日志
    if (isError) {
        const errorLogFile = path.join(logDir, `error_${date}.log`);
        fs.appendFileSync(
            errorLogFile,
            logMessage + '\n',
            { encoding: 'utf8' }
        );
    }
}

// 仅记录到日志文件，不在控制台显示
function logToFile(message, isError = false) {
    log(message, isError, false);
}

// 添加一个全局变量记录是否已显示统计信息框架
let displayInitialized = false;

// 添加全局变量，防止显示重复
let isDisplaying = false;
let displayQueue = [];
let lastDisplayTime = 0;

// 显示格式化的账户信息
function displayAccountInfo() {
    try {
        // 如果已经有显示操作在进行中，将此次调用加入队列后返回
        if (isDisplaying) {
            // 如果距离上次显示不到3秒，则不加入队列，直接忽略此次调用
            const now = Date.now();
            if (now - lastDisplayTime < 3000) {
                return;
            }
            
            // 如果队列中已有等待的显示请求，不再添加新的
            if (displayQueue.length === 0) {
                displayQueue.push(Date.now());
                // 设置一个短延迟后检查队列
                setTimeout(checkDisplayQueue, 1000);
            }
            return;
        }
        
        // 设置显示状态锁定
        isDisplaying = true;
        lastDisplayTime = Date.now();
        
        // 准备数据
        const timeNow = new Date().toLocaleString();
        const tradingCoin = userConfig.trading.tradingCoin;
        const symbol = `${tradingCoin}_USDC`;
        const takeProfitPercentage = userConfig.trading.takeProfitPercentage;
        const elapsedTime = getElapsedTimeString(config.scriptStartTime, new Date());
        
        // 价格信息
        let priceInfo = "等待WebSocket数据...";  // 修改默认显示消息
        let priceChangeSymbol = "";
        let percentProgress = "0";
        
        // 显示WebSocket连接状态
        let wsStatusInfo = wsConnected ? "已连接" : "连接中...";
        
        // 只要有价格信息就显示，不再依赖averagePrice
        if (config.currentPriceInfo && config.currentPriceInfo.price) {
            const currentPrice = config.currentPriceInfo.price;
            priceInfo = `${currentPrice.toFixed(1)} USDC`;
            
            // 涨跌幅和进度百分比只在有成交均价时才计算
            if (config.stats.averagePrice > 0) {
                const priceChange = config.currentPriceInfo.increase;
                const absChange = Math.abs(priceChange).toFixed(2);
                
                priceChangeSymbol = priceChange >= 0 ? "↑" : "↓";
                
                // 计算离止盈目标的进度百分比
                if (priceChange > 0 && takeProfitPercentage > 0) {
                    percentProgress = Math.min(100, (priceChange / takeProfitPercentage * 100)).toFixed(0);
                }
            }
        }
        
        // 清屏并重新绘制整个界面
        console.clear();
        
        // 一次性构建整个界面内容，然后一次打印，避免内容被分割
        let display = '===== Backpack 自动交易系统 =====\n';
        display += `当前时间: ${timeNow}\n`;
        display += `交易对: ${symbol}\n`;
        display += `脚本启动时间: ${config.scriptStartTime.toLocaleString()}\n`;
        display += `运行时间: ${elapsedTime}\n`;
        display += `\n===== 市场信息 =====\n`;
        display += `WebSocket: ${wsStatusInfo}\n`;
        display += `当前价格: ${priceInfo}\n`;
        display += `涨跌幅: ${priceChangeSymbol} ${Math.abs(config.currentPriceInfo?.increase || 0).toFixed(2)}%\n`;
        display += `止盈目标: ${takeProfitPercentage}%\n`;
        display += `完成进度: ${percentProgress}%\n`;
        
        display += `\n===== 订单统计 =====\n`;
        display += `总订单数: ${config.stats.totalOrders}\n`;
        display += `已成交订单: ${config.stats.filledOrders}\n`;
        display += `成交总金额: ${config.stats.totalFilledAmount.toFixed(2)} USDC\n`;
        display += `成交总数量: ${config.stats.totalFilledQuantity.toFixed(6)} ${tradingCoin}\n`;
        display += `平均成交价: ${config.stats.averagePrice.toFixed(2)} USDC\n`;
        
        // 显示盈亏情况
        if (config.stats.filledOrders > 0 && config.currentPriceInfo && config.stats.totalFilledQuantity > 0) {
            const currentValue = config.currentPriceInfo.price * config.stats.totalFilledQuantity;
            const profit = currentValue - config.stats.totalFilledAmount;
            const profitPercent = profit / config.stats.totalFilledAmount * 100;
            const profitSymbol = profit >= 0 ? "↑" : "↓";
            
            display += `当前持仓价值: ${currentValue.toFixed(2)} USDC\n`;
            display += `盈亏金额: ${profitSymbol} ${Math.abs(profit).toFixed(2)} USDC\n`;
            display += `盈亏百分比: ${profitSymbol} ${Math.abs(profitPercent).toFixed(2)}%\n`;
        }
        
        display += `最后更新: ${new Date().toLocaleString()}\n`;
        
        // 添加显示价格更新来源信息
        if (config.currentPriceInfo && config.currentPriceInfo.source) {
            display += `\n价格数据来源: ${config.currentPriceInfo.source}\n`;
        }
        
        // 一次性打印全部内容
        console.log(display);
        
        // 不再需要记录初始化标志
        displayInitialized = true;
        
        // 解除显示锁定
        isDisplaying = false;
        
        // 如果队列中有等待的显示请求，处理下一个
        if (displayQueue.length > 0) {
            setTimeout(checkDisplayQueue, 1000);
        }
        
    } catch (error) {
        // 如果显示过程出错，回退到简单显示
        log(`显示信息时发生错误: ${error.message}`);
        // 简单显示函数
        console.log(`\n价格: ${config.currentPriceInfo?.price || '未知'} USDC`);
        console.log(`订单: ${config.stats.filledOrders}/${config.stats.totalOrders}`);
        
        // 出错时也要解除锁定
        isDisplaying = false;
    }
}

// 检查显示队列并处理下一个显示请求
function checkDisplayQueue() {
    if (displayQueue.length > 0 && !isDisplaying) {
        displayQueue.shift(); // 移除最早的请求
        displayAccountInfo();
    }
}

// 获取已运行时间的格式化字符串
function getElapsedTimeString(startTime, endTime) {
    const elapsedMs = endTime - startTime;
    const seconds = Math.floor(elapsedMs / 1000) % 60;
    const minutes = Math.floor(elapsedMs / (1000 * 60)) % 60;
    const hours = Math.floor(elapsedMs / (1000 * 60 * 60));
    
    return `${hours}小时${minutes}分${seconds}秒`;
}

// 读取配置文件
function loadConfig() {
    try {
        const configPath = path.join(__dirname, 'backpack_trading_config.json');
        log(`加载配置文件: ${configPath}`);
        
        if (!fs.existsSync(configPath)) {
            throw new Error(`配置文件不存在: ${configPath}`);
        }
        
        const configData = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configData);
        
        log(`配置文件加载成功`);
        return config;
    } catch (error) {
        log(`加载配置文件失败: ${error.message}`, true);
        throw error;
    }
}

// 全局用户配置
const userConfig = loadConfig();

// 配置参数 - 现在从配置文件中读取
const config = {
    // API配置
    privateKey: userConfig.api.privateKey,
    publicKey: userConfig.api.publicKey,
    
    // 交易配置
    pricePrecision: 2,        // 默认价格精度
    priceTickSize: userConfig.advanced.priceTickSize || 0.01,  // 价格最小变动单位
    minOrderAmount: userConfig.advanced.minOrderAmount || 10,  // 最小订单金额
    
    // 不同币种的数量精度配置
    quantityPrecisions: userConfig.quantityPrecisions || {
        'BTC': 5,     // BTC数量精度
        'ETH': 4,     // ETH数量精度
        'SOL': 2,     // SOL数量精度
        'DEFAULT': 2  // 其他币种默认数量精度
    },
    
    // 不同币种的价格精度配置
    pricePrecisions: userConfig.pricePrecisions || {
        'BTC': 0,     // BTC价格精度
        'ETH': 2,     // ETH价格精度
        'SOL': 2,     // SOL价格精度
        'DEFAULT': 2  // 其他币种默认价格精度
    },
    
    // 不同币种的最小交易量配置
    minQuantities: userConfig.minQuantities || {
        'BTC': 0.00001,   // BTC最小交易量
        'ETH': 0.001,     // ETH最小交易量
        'SOL': 0.01,      // SOL最小交易量
        'DEFAULT': 0.1    // 其他币种默认最小交易量
    },
    
    // 统计信息
    stats: {
        totalOrders: 0,
        filledOrders: 0,
        totalFilledAmount: 0,
        totalFilledQuantity: 0,
        averagePrice: 0,
        lastUpdateTime: null
    },
    
    // 已处理的订单ID集合
    processedOrderIds: new Set(),
    
    // 脚本启动时间
    scriptStartTime: new Date(),
    
    // 当前交易对
    symbol: null,
    
    // 存储创建的所有订单ID
    allCreatedOrderIds: new Set(),
    
    // 存储创建订单时的信息，用于检查成交情况
    createdOrders: {},
    
    // 未成交订单ID集合
    pendingOrderIds: new Set(),
    
    // 已创建订单的价格-数量标识，防止重复创建
    createdOrderSignatures: new Set(),
};

// 创建readline接口 - 自动模式下实际上不需要，但保留以防止错误
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// 读取用户输入的函数 - 自动模式下直接返回配置的值
async function question(prompt) {
    // 解析问题，返回对应的配置值
    if (prompt.includes('是否卖出所有非USDC资产')) {
        return userConfig.actions.sellNonUsdcAssets ? 'y' : 'n';
    } else if (prompt.includes('请输入交易币种')) {
        return userConfig.trading.tradingCoin;
    } else if (prompt.includes('是否撤销')) {
        return userConfig.actions.cancelAllOrders ? 'y' : 'n';
    } else if (prompt.includes('请输入最大跌幅百分比')) {
        return userConfig.trading.maxDropPercentage.toString();
    } else if (prompt.includes('请输入总投资金额')) {
        return userConfig.trading.totalAmount.toString();
    } else if (prompt.includes('请输入买入次数')) {
        return userConfig.trading.orderCount.toString();
    } else if (prompt.includes('请输入每次金额增加的百分比')) {
        return userConfig.trading.incrementPercentage.toString();
    } else if (prompt.includes('请输入止盈百分比')) {
        return userConfig.trading.takeProfitPercentage.toString();
    } else if (prompt.includes('是否继续创建订单')) {
        return 'y'; // 自动模式下始终确认
    } else {
        log(`未知的问题提示: ${prompt}，返回默认值'y'`);
        return 'y';
    }
}

// 执行API请求并重试
async function executeWithRetry(client, apiMethod, params, maxRetries = 3) {
    let retries = 0;
    let lastError = null;
    
    while (retries < maxRetries) {
        try {
            // 添加超时处理
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('API请求超时，30秒无响应')), 30000);
            });
            
            // 使用Promise.race确保API请求不会永久挂起
            return await Promise.race([
                apiMethod.call(client, params),
                timeoutPromise
            ]);
        } catch (error) {
            lastError = error;
            
            // 详细记录错误信息
            log(`API请求失败 (${retries + 1}/${maxRetries}): ${error.message}`, true);
            
            // 如果有响应体，记录它
            if (error.response?.body) {
                log(`错误响应: ${JSON.stringify(error.response.body)}`, true);
            }
            
            // 如果还有重试机会，则等待后重试
            if (retries < maxRetries - 1) {
                const waitMs = 1000 * Math.pow(2, retries);
                log(`等待 ${waitMs}ms 后重试...`);
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }
            retries++;
        }
    }
    
    // 所有重试都失败了，抛出带有详细信息的错误
    throw new Error(`API请求失败，尝试了 ${maxRetries} 次: ${lastError?.message || '未知错误'}`);
}

// 调整数值精度
function adjustPrecision(value, precision) {
    const multiplier = Math.pow(10, precision);
    return Math.floor(value * multiplier) / multiplier;
}

// 调整价格到tickSize，并根据交易对的精度要求进行处理
function adjustPriceToTickSize(price, tradingCoin) {
    const tickSize = config.priceTickSize;
    // 获取该币种的价格精度
    const precision = config.pricePrecisions[tradingCoin] || config.pricePrecisions.DEFAULT;
    
    // BTC特殊处理 - 确保价格是整数
    if (tradingCoin === 'BTC') {
        // 对BTC价格，直接向下取整到整数
        return Math.floor(price);
    }
    
    // 其他币种正常处理
    // 先向下取整到tickSize的倍数
    const adjustedPrice = Math.floor(price / tickSize) * tickSize;
    // 然后限制小数位数
    return Number(adjustedPrice.toFixed(precision));
}

// 调整数量到stepSize
function adjustQuantityToStepSize(quantity, tradingCoin) {
    const precision = config.quantityPrecisions[tradingCoin] || config.quantityPrecisions.DEFAULT;
    const stepSize = Math.pow(10, -precision);
    const adjustedQuantity = Math.floor(quantity / stepSize) * stepSize;
    return Number(adjustedQuantity.toFixed(precision));
}

// 计算递增订单
function calculateIncrementalOrders(currentPrice, maxDropPercentage, totalAmount, orderCount, incrementPercentage, minOrderAmount, tradingCoin) {
    const orders = [];
    const quantityPrecision = config.quantityPrecisions[tradingCoin] || config.quantityPrecisions.DEFAULT;
    
    // 计算价格区间
    const lowestPrice = currentPrice * (1 - maxDropPercentage / 100);
    const priceStep = (currentPrice - lowestPrice) / (orderCount - 1);
    
    // 计算基础订单金额（使用等比数列求和公式）
    // 总金额 = 基础金额 * (1 + r + r^2 + ... + r^(n-1))
    // 总金额 = 基础金额 * (1 - r^n) / (1 - r)
    // 基础金额 = 总金额 * (1 - r) / (1 - r^n)
    const r = 1 + incrementPercentage / 100; // 递增比例
    
    // 确保基础订单金额不小于最小订单金额
    const calculatedBaseAmount = totalAmount * (r - 1) / (Math.pow(r, orderCount) - 1);
    const baseAmount = Math.max(minOrderAmount, calculatedBaseAmount);
    
    // 计算实际总金额
    let actualTotalAmount = 0;
    for (let i = 0; i < orderCount; i++) {
        actualTotalAmount += baseAmount * Math.pow(r, i);
    }
    
    // 如果实际总金额超过用户输入的总金额，按比例缩小基础金额
    if (actualTotalAmount > totalAmount) {
        const scale = totalAmount / actualTotalAmount;
        actualTotalAmount = 0;
        
        // 创建订单
        for (let i = 0; i < orderCount; i++) {
            // 计算当前订单价格
            const rawPrice = Number((currentPrice - (priceStep * i)).toFixed(config.pricePrecision));
            // 调整价格到交易所接受的格式
            const price = adjustPriceToTickSize(rawPrice, tradingCoin);
            
            // 计算当前订单金额（递增并缩放）
            const orderAmount = baseAmount * Math.pow(r, i) * scale;
            
            // 计算数量并调整精度
            const quantity = adjustQuantityToStepSize(orderAmount / price, tradingCoin);
            const actualAmount = Number((price * quantity).toFixed(2));
            
            // 只有当订单金额满足最小要求时才添加
            if (actualAmount >= minOrderAmount) {
                orders.push({
                    price,
                    quantity,
                    amount: actualAmount
                });
                actualTotalAmount += actualAmount;
            }
        }
    } else {
        // 创建订单
        for (let i = 0; i < orderCount; i++) {
            // 计算当前订单价格
            const rawPrice = Number((currentPrice - (priceStep * i)).toFixed(config.pricePrecision));
            // 调整价格到交易所接受的格式
            const price = adjustPriceToTickSize(rawPrice, tradingCoin);
            
            // 计算当前订单金额（递增）
            const orderAmount = baseAmount * Math.pow(r, i);
            
            // 计算数量并调整精度
            const quantity = adjustQuantityToStepSize(orderAmount / price, tradingCoin);
            const actualAmount = Number((price * quantity).toFixed(2));
            
            // 只有当订单金额满足最小要求时才添加
            if (actualAmount >= minOrderAmount) {
                orders.push({
                    price,
                    quantity,
                    amount: actualAmount
                });
                actualTotalAmount += actualAmount;
            }
        }
    }
    
    // 如果没有生成任何订单，抛出错误
    if (orders.length === 0) {
        throw new Error('无法生成有效订单，请检查输入参数');
    }
    
    log(`计划总金额: ${totalAmount.toFixed(2)} USDC`);
    log(`实际总金额: ${actualTotalAmount.toFixed(2)} USDC`);
    
    return orders;
}

// 撤销所有未完成的订单
async function cancelAllOrders(client) {
    try {
        log('正在获取未完成订单...');
        // 使用client.getOpenOrders方法获取未完成订单
        const openOrders = await executeWithRetry(client, client.GetOpenOrders, { symbol: config.symbol });
        
        if (!openOrders || openOrders.length === 0) {
            log('没有未完成的订单需要撤销');
            return;
        }
        
        // 过滤出买入订单
        const activeBuyOrders = openOrders.filter(order => order.side === 'Bid') || [];
        
        if (activeBuyOrders.length === 0) {
            log('没有未完成的买入订单需要撤销');
            return;
        }
        
        log(`发现 ${activeBuyOrders.length} 个未完成买入订单，开始撤销...`);
        if (activeBuyOrders.length > 0) {
            const firstOrder = activeBuyOrders[0];
            log(`首个订单信息: ID=${firstOrder.id}, 价格=${firstOrder.price}, 数量=${firstOrder.quantity}, 状态=${firstOrder.status || 'New'}`);
        }
        
        // 尝试方法1: 使用CancelOpenOrders方法（这是backpack_client.js中实际存在的方法）
        try {
            log('尝试使用CancelOpenOrders方法撤销所有订单...');
            await executeWithRetry(client, client.CancelOpenOrders, { symbol: config.symbol });
            log('成功使用CancelOpenOrders撤销所有订单');
            return;
        } catch (error1) {
            log(`使用CancelOpenOrders方法撤销失败: ${error1.message}，尝试下一种方法`, true);
        }
        
        // 尝试方法2: 直接调用API端点而不是CancelAllOrders
        try {
            log('尝试使用privateMethod直接调用orderCancelAll端点...');
            await client.privateMethod('orderCancelAll', { symbol: config.symbol });
            log('成功通过privateMethod撤销所有订单');
            return;
        } catch (error2) {
            log(`使用privateMethod撤销失败: ${error2.message}，尝试逐个撤销`, true);
        }
        
        // 如果批量撤销方法都失败，则尝试逐个撤销
        for (const order of activeBuyOrders) {
            try {
                // 记录完整订单信息，用于调试
                log(`处理订单: ID=${order.id}, 价格=${order.price}, 数量=${order.quantity}, 状态=${order.status || 'New'}`);
                
                // 尝试不同格式的订单ID
                const orderId = order.id || order.orderId || order.order_id;
                if (!orderId) {
                    log('找不到有效的订单ID，跳过', true);
                    continue;
                }
                
                // 提取订单ID（数字和字符串形式）
                const orderIdNumber = Number(orderId);
                const orderIdString = String(orderId);
                
                // 记录将要使用的订单ID值
                log(`将使用订单ID: ${orderId} (数字形式: ${orderIdNumber}, 字符串形式: ${orderIdString})`);
                
                // 尝试方法1: 直接使用私有方法
                try {
                    log(`尝试使用privateMethod直接调用orderCancel...`);
                    await executeWithRetry(client, client.orderCancel, { symbol: config.symbol, orderId: orderIdNumber });
                    log(`成功使用privateMethod撤销订单ID: ${orderId}`);
                    continue;
                } catch (error3) {
                    log(`使用privateMethod撤销失败: ${error3.message}`, true);
                }
                
                // 尝试方法2: 使用CancelOrder
                try {
                    log(`尝试使用CancelOrder和数字型ID撤销订单...`);
                    await executeWithRetry(client, client.CancelOrder, {
                        symbol: config.symbol,
                        orderId: orderIdNumber
                    });
                    log(`成功使用CancelOrder撤销订单ID: ${orderId}`);
                    continue;
                } catch (error4) {
                    log(`使用CancelOrder和数字型ID撤销失败: ${error4.message}`, true);
                }
                
                // 尝试字符串类型ID
                try {
                    log(`尝试使用CancelOrder和字符串型ID撤销订单...`);
                    await executeWithRetry(client, client.CancelOrder, {
                        symbol: config.symbol,
                        orderId: orderIdString
                    });
                    log(`成功使用CancelOrder和字符串ID撤销订单ID: ${orderId}`);
                    continue;
                } catch (error5) {
                    log(`使用CancelOrder和字符串ID撤销失败: ${error5.message}`, true);
                }
                
                // 尝试使用取消多个订单的API
                try {
                    log(`尝试使用privateMethod和orderIds数组...`);
                    await executeWithRetry(client, client.orderCancel, {
                        symbol: config.symbol,
                        orderIds: [orderIdString]
                    });
                    log(`成功使用privateMethod和orderIds数组撤销订单ID: ${orderId}`);
                    continue;
                } catch (error6) {
                    log(`使用privateMethod和orderIds数组撤销失败: ${error6.message}`, true);
                }
                
                // 所有尝试都失败了
                log(`无法撤销订单ID: ${orderId}，尝试了所有可能的方法都失败`, true);
                
            } catch (cancelError) {
                log(`撤销订单时发生错误: ${cancelError.message}`, true);
                if (cancelError.response?.body) {
                    log(`撤销订单错误详情: ${JSON.stringify(cancelError.response.body)}`, true);
                }
            }
            
            // 添加延迟避免API限制
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        log('所有订单撤销操作完成或已尝试');
    } catch (error) {
        log(`撤销订单时发生错误: ${error.message}`, true);
        if (error.response?.body) {
            log(`错误详情: ${JSON.stringify(error.response.body)}`, true);
        }
        // 继续执行，不抛出错误
    }
}

// 创建买入订单
async function createBuyOrder(client, symbol, price, quantity, tradingCoin) {
    try {
        log(`创建买入订单: 价格=${price} USDC, 数量=${quantity} ${tradingCoin}`);
        
        // 获取精度
        const quantityPrecision = config.quantityPrecisions[tradingCoin] || config.quantityPrecisions.DEFAULT;
        
        // 调整数量精度
        const adjustedQuantity = adjustPrecision(quantity, quantityPrecision);
        log(`调整后数量: ${adjustedQuantity} ${tradingCoin}`);
        
        // 调整价格精度和格式
        const adjustedPrice = adjustPriceToTickSize(price, tradingCoin);
        log(`调整后价格: ${adjustedPrice} USDC`);
        
        // 计算订单金额
        const orderAmount = adjustedPrice * adjustedQuantity;
        log(`订单金额: ${orderAmount.toFixed(2)} USDC`);
        
        // 创建订单签名，用于防止重复创建
        const orderSignature = `${adjustedPrice}_${adjustedQuantity}`;
        
        // 检查是否已创建过相同参数的订单
        if (config.createdOrderSignatures.has(orderSignature)) {
            log(`跳过重复订单创建，价格=${adjustedPrice}, 数量=${adjustedQuantity}`);
            throw new Error('重复订单，已跳过创建');
        }
        
        // 标记为已创建（即使API可能失败）
        config.createdOrderSignatures.add(orderSignature);
        
        // 创建买入订单
        const orderParams = {
            symbol: symbol, 
            side: 'Bid',           // 买入
            orderType: 'Limit',    // 限价单
            quantity: adjustedQuantity.toString(),
            price: adjustedPrice.toString(),
            timeInForce: 'GTC'     // Good Till Canceled
        };
        
        // 执行API创建订单 - 直接创建订单，不做其他API请求
        const response = await executeWithRetry(client, client.ExecuteOrder, orderParams);
        
        // 记录订单信息 - 新增
        if (response && response.id) {
            // 添加到已创建订单ID集合
            config.allCreatedOrderIds.add(response.id);
            
            // 保存完整的订单信息
            config.createdOrders[response.id] = {
                id: response.id,
                price: parseFloat(adjustedPrice),
                quantity: parseFloat(adjustedQuantity),
                amount: orderAmount,
                side: 'Bid',
                symbol: symbol,
                createTime: new Date(),
                processed: false,
                status: response.status || 'New'  // 记录初始状态
            };
            
            config.stats.totalOrders++;
            log(`订单已创建, ID: ${response.id}, 初始状态: ${response.status || 'New'}`);
            
            // 如果订单刚创建就显示已成交，直接更新统计
            if (response.status === 'Filled') {
                log(`订单创建时已成交: ID=${response.id}`);
                
                // 更新统计信息
                if (!config.processedOrderIds.has(response.id)) {
                    config.processedOrderIds.add(response.id);
                    config.stats.filledOrders++;
                    config.stats.totalFilledAmount += orderAmount;
                    config.stats.totalFilledQuantity += parseFloat(adjustedQuantity);
                    
                    // 计算平均价格
                    if (config.stats.totalFilledQuantity > 0) {
                        config.stats.averagePrice = config.stats.totalFilledAmount / config.stats.totalFilledQuantity;
                    }
                    
                    log(`更新统计: 成交订单=${config.stats.filledOrders}, 成交金额=${config.stats.totalFilledAmount.toFixed(2)}, 成交数量=${config.stats.totalFilledQuantity.toFixed(6)}, 均价=${config.stats.averagePrice.toFixed(2)}`);
                }
            }
        }
        
        return response;
    } catch (error) {
        // 如果是标记为重复订单的错误，以不同方式处理
        if (error.message === '重复订单，已跳过创建') {
            log(`跳过重复订单创建`);
            return { skipped: true, message: '重复订单已跳过' };
        }
        
        log(`创建买入订单失败: ${error.message}`, true);
        throw error;
    }
}

// 更新统计信息
function updateStats(order) {
    config.stats.totalOrders++;
    
    // 确保有成交信息再更新成交统计
    if (order.status === 'Filled' || order.status === 'PartiallyFilled') {
        // 确保使用数字类型进行计算
        const filledAmount = parseFloat(order.filledAmount || 0);
        const filledQuantity = parseFloat(order.filledQuantity || 0);
        
        // 检查是否已处理过这个订单ID
        if (!config.processedOrderIds.has(order.id)) {
            config.processedOrderIds.add(order.id);
            
            if (!isNaN(filledAmount) && filledAmount > 0) {
                config.stats.totalFilledAmount += filledAmount;
            }
            
            if (!isNaN(filledQuantity) && filledQuantity > 0) {
                config.stats.totalFilledQuantity += filledQuantity;
                config.stats.filledOrders++;
            }
            
            // 只有当有效成交量存在时才计算均价
            if (config.stats.totalFilledQuantity > 0) {
                config.stats.averagePrice = config.stats.totalFilledAmount / config.stats.totalFilledQuantity;
            }
            
            log(`更新统计: 成交订单=${config.stats.filledOrders}, 成交金额=${config.stats.totalFilledAmount.toFixed(2)}, 成交数量=${config.stats.totalFilledQuantity.toFixed(6)}, 均价=${config.stats.averagePrice.toFixed(2)}`);
        } else {
            log(`跳过已统计过的订单ID: ${order.id}`);
        }
    }
    
    config.stats.lastUpdateTime = new Date();
    
    // 更新交易周期统计
    updateCycleStats(order, config);
    
    // 记录订单信息到周期日志
    if (cycleLogFile) {
        logOrderToCycle(cycleLogFile, order, config);
    }
}

// 交易周期日志文件
let cycleLogFile = null;

// 更新交易周期统计
function updateCycleStats(order, config) {
    // 此函数留空，仅防止未定义错误
    // 实际功能可以在未来版本中实现
}

// 记录订单到交易周期日志
function logOrderToCycle(logFile, order, config) {
    // 此函数留空，仅防止未定义错误
    // 实际功能可以在未来版本中实现
}

// 显示统计信息
function displayStats() {
    log('\n=== 订单统计信息 ===');
    log(`总挂单次数: ${config.stats.totalOrders}`);
    log(`已成交订单: ${config.stats.filledOrders}`);
    log(`总成交金额: ${config.stats.totalFilledAmount.toFixed(2)} USDC`);
    log(`总成交数量: ${config.stats.totalFilledQuantity.toFixed(6)}`);
    log(`平均成交价格: ${config.stats.averagePrice.toFixed(2)} USDC`);
    
    // 计算并显示盈亏情况
    if (config.stats.filledOrders > 0 && config.currentPriceInfo && config.stats.totalFilledQuantity > 0) {
        const currentValue = config.currentPriceInfo.price * config.stats.totalFilledQuantity;
        const cost = config.stats.totalFilledAmount;
        const profit = currentValue - cost;
        const profitPercent = (profit / cost * 100);
        
        // 添加颜色指示
        const profitSymbol = profit >= 0 ? '+' : '-';
        log(`当前持仓价值: ${currentValue.toFixed(2)} USDC`);
        log(`当前市场价格: ${config.currentPriceInfo.price.toFixed(2)} USDC (${profitSymbol}${Math.abs(config.currentPriceInfo.increase).toFixed(2)}%)`);
        log(`盈亏金额: ${profitSymbol}${Math.abs(profit).toFixed(2)} USDC`);
        log(`盈亏百分比: ${profitSymbol}${Math.abs(profitPercent).toFixed(2)}%`);
    }
    
    log(`最后更新时间: ${config.stats.lastUpdateTime ? config.stats.lastUpdateTime.toLocaleString() : '无'}`);
    log('==================\n');
}

// 查询持仓信息
async function getPosition(client, symbol) {
    try {
        // 使用Balance API获取持仓信息
        const balances = await executeWithRetry(client, client.Balance);
        
        if (!balances) {
            return null;
        }

        // 从symbol中提取币种（例如：从"BTC_USDC"中提取"BTC"）
        const coin = symbol.split('_')[0];
        
        // 查找对应币种的余额
        if (!balances[coin] || parseFloat(balances[coin].available) <= 0) {
            return null;
        }

        // 构造持仓信息
        return {
            quantity: balances[coin].available,
            asset: coin,
            total: (parseFloat(balances[coin].available) + parseFloat(balances[coin].locked)).toString(),
            available: balances[coin].available
        };
    } catch (error) {
        log(`查询持仓失败: ${error.message}`, true);
        if (error.response?.body) {
            log(`错误详情: ${JSON.stringify(error.response.body)}`, true);
        }
        return null;
    }
}

// 查询订单历史并更新统计
async function queryOrdersAndUpdateStats(client, symbol) {
    try {
        logToFile('查询当前交易周期新成交的订单...');
        
        // 添加调试信息，帮助排查统计问题
        logToFile(`当前已创建订单ID数量: ${config.allCreatedOrderIds.size}, 已处理订单ID数量: ${config.processedOrderIds.size}`);
        
        // 保存当前的统计数据，防止查询过程覆盖已有数据
        const currentStats = {
            filledOrders: config.stats.filledOrders,
            totalFilledAmount: config.stats.totalFilledAmount,
            totalFilledQuantity: config.stats.totalFilledQuantity,
            averagePrice: config.stats.averagePrice
        };
        logToFile(`当前统计数据 - 已成交订单: ${currentStats.filledOrders}, 成交金额: ${currentStats.totalFilledAmount.toFixed(2)}, 成交数量: ${currentStats.totalFilledQuantity.toFixed(6)}`);
        
        // 获取当前未成交订单
        let currentOpenOrders = [];
        try {
            logToFile('获取当前未成交订单...');
            currentOpenOrders = await executeWithRetry(client, client.GetOpenOrders, { symbol });
            
            if (!currentOpenOrders) {
                currentOpenOrders = [];
            }
            
            // 记录当前未成交订单数量
            log(`当前未成交订单数量: ${currentOpenOrders.length}`);
            
            // 增加日志记录当前未成交订单详情
            if (currentOpenOrders.length > 0) {
                logToFile(`当前未成交订单详情:`);
                currentOpenOrders.forEach((order, index) => {
                    logToFile(`  #${index+1}: ID=${order.id}, 价格=${order.price}, 数量=${order.quantity}`);
                });
            }
        } catch (error) {
            logToFile(`获取未成交订单失败: ${error.message}`, true);
            return currentStats.filledOrders > 0;
        }
        
        // 提取当前未成交订单ID
        const currentPendingOrderIds = new Set(currentOpenOrders.map(order => order.id));
        
        // 记录跟踪状态
        log(`上次记录的未成交订单数量: ${config.pendingOrderIds.size}`);
        log(`当前未成交订单数量: ${currentPendingOrderIds.size}`);
        
        // 特殊情况处理：首次运行但已创建了订单
        if (config.pendingOrderIds.size === 0 && config.allCreatedOrderIds.size > 0) {
            log(`初次检查：发现已创建 ${config.allCreatedOrderIds.size} 个订单，但当前只有 ${currentPendingOrderIds.size} 个未成交订单`);
            
            // 找出已成交的订单
            const potentiallyFilledOrders = [];
            for (const orderId of config.allCreatedOrderIds) {
                if (!currentPendingOrderIds.has(orderId)) {
                    potentiallyFilledOrders.push(orderId);
                }
            }
            
            if (potentiallyFilledOrders.length > 0) {
                log(`检测到 ${potentiallyFilledOrders.length} 个已创建订单不在当前未成交列表中，可能已成交`);
                log(`已成交订单ID列表: ${potentiallyFilledOrders.join(', ')}`);
                
                // 处理这些可能已成交的订单
                for (const orderId of potentiallyFilledOrders) {
                    // 检查是否已处理过
                    if (config.processedOrderIds.has(orderId)) {
                        log(`订单ID ${orderId} 已处理过，跳过`);
                        continue;
                    }
                    
                    // 获取创建时保存的订单信息
                    const orderInfo = config.createdOrders[orderId];
                    
                    if (orderInfo && orderInfo.side === 'Bid') {
                        log(`初始检查：订单ID ${orderId} 判定为已成交`);
                        log(`使用创建时记录的信息: 价格=${orderInfo.price}, 数量=${orderInfo.quantity}, 金额=${orderInfo.amount.toFixed(2)}`);
                        
                        // 更新统计信息
                        config.stats.filledOrders++;
                        config.stats.totalFilledAmount += orderInfo.amount;
                        config.stats.totalFilledQuantity += orderInfo.quantity;
                        
                        // 标记为已处理
                        config.processedOrderIds.add(orderId);
                        orderInfo.processed = true;
                        
                        log(`更新统计数据: 已成交订单=${config.stats.filledOrders}, 成交数量=${config.stats.totalFilledQuantity.toFixed(6)}, 成交金额=${config.stats.totalFilledAmount.toFixed(2)}`);
                    } else if (!orderInfo) {
                        // 尝试从API获取订单信息
                        try {
                            log(`未找到订单ID ${orderId} 的创建记录，尝试通过API获取详细信息`);
                            const orderDetails = await client.privateMethod('orderDetail', { orderId: orderId });
                            
                            if (orderDetails && orderDetails.side === 'Bid') {
                                const filledQuantity = parseFloat(orderDetails.executedQuantity || 0);
                                const filledAmount = parseFloat(orderDetails.executedQuoteQuantity || 0);
                                
                                if (filledQuantity > 0 && filledAmount > 0) {
                                    log(`API返回订单详情: 价格=${orderDetails.price}, 成交数量=${filledQuantity}, 成交金额=${filledAmount}`);
                                    
                                    config.stats.filledOrders++;
                                    config.stats.totalFilledAmount += filledAmount;
                                    config.stats.totalFilledQuantity += filledQuantity;
                                    
                                    config.processedOrderIds.add(orderId);
                                    
                                    log(`更新统计数据: 已成交订单=${config.stats.filledOrders}, 成交数量=${config.stats.totalFilledQuantity.toFixed(6)}, 成交金额=${config.stats.totalFilledAmount.toFixed(2)}`);
                                }
                            }
                        } catch (detailError) {
                            log(`获取订单详情失败: ${detailError.message}`, true);
                        }
                    }
                }
                
                // 更新平均价格
                if (config.stats.totalFilledQuantity > 0) {
                    config.stats.averagePrice = config.stats.totalFilledAmount / config.stats.totalFilledQuantity;
                    log(`更新平均成交价: ${config.stats.averagePrice.toFixed(2)} USDC`);
                }
                
                // 更新上次检查时间
                config.stats.lastUpdateTime = new Date();
                
                // 显示更新后的统计信息
                displayStats();
            }
            
            // 保存当前未成交订单ID列表
            config.pendingOrderIds = currentPendingOrderIds;
            return config.stats.filledOrders > 0;
        }
        
        // 如果是标准的首次运行（没有预先创建订单），只保存未成交订单ID列表
        if (config.pendingOrderIds.size === 0) {
            log(`首次检查，记录 ${currentPendingOrderIds.size} 个未成交订单`);
            config.pendingOrderIds = currentPendingOrderIds;
            return currentStats.filledOrders > 0;
        }
        
        // 找出消失的订单（可能已成交或被取消）
        const missingOrderIds = [];
        for (const orderId of config.pendingOrderIds) {
            if (!currentPendingOrderIds.has(orderId)) {
                missingOrderIds.push(orderId);
            }
        }
        
        log(`检测到 ${missingOrderIds.length} 个订单不在当前未成交列表中`);
        
        // 如果有消失的订单，记录详细信息
        if (missingOrderIds.length > 0) {
            log(`消失的订单ID: ${missingOrderIds.join(', ')}`);
        }
        
        // 处理消失的订单
        if (missingOrderIds.length > 0) {
            // 记录是否有新成交订单
            let hasNewFilledOrders = false;
            
            // 根据创建时的记录处理每个消失的订单
            for (const orderId of missingOrderIds) {
                // 检查是否已处理过
                if (config.processedOrderIds.has(orderId)) {
                    log(`订单ID ${orderId} 已处理过，跳过`);
                    continue;
                }
                
                // 获取创建时保存的订单信息
                const orderInfo = config.createdOrders[orderId];
                
                if (orderInfo && orderInfo.side === 'Bid') {
                    log(`订单ID ${orderId} 已不在未成交列表中，判定为已成交`);
                    log(`使用创建时记录的信息: 价格=${orderInfo.price}, 数量=${orderInfo.quantity}, 金额=${orderInfo.amount.toFixed(2)}`);
                    
                    // 更新统计信息
                    config.stats.filledOrders++;
                    config.stats.totalFilledAmount += orderInfo.amount;
                    config.stats.totalFilledQuantity += orderInfo.quantity;
                    
                    // 标记为已处理
                    config.processedOrderIds.add(orderId);
                    orderInfo.processed = true;
                    
                    hasNewFilledOrders = true;
                    
                    log(`更新统计数据: 已成交订单=${config.stats.filledOrders}, 成交数量=${config.stats.totalFilledQuantity.toFixed(6)}, 成交金额=${config.stats.totalFilledAmount.toFixed(2)}`);
                } else if (!orderInfo) {
                    log(`未找到订单ID ${orderId} 的创建记录，尝试通过API获取详细信息`);
                    
                    // 执行原来的逻辑，尝试通过API获取订单详情
                    try {
                        const orderDetails = await client.privateMethod('orderDetail', { orderId: orderId });
                        
                        if (orderDetails && orderDetails.side === 'Bid') {
                            const filledQuantity = parseFloat(orderDetails.executedQuantity || 0);
                            const filledAmount = parseFloat(orderDetails.executedQuoteQuantity || 0);
                            
                            if (filledQuantity > 0 && filledAmount > 0) {
                                log(`API返回订单详情: 价格=${orderDetails.price}, 成交数量=${filledQuantity}, 成交金额=${filledAmount}`);
                                
                                config.stats.filledOrders++;
                                config.stats.totalFilledAmount += filledAmount;
                                config.stats.totalFilledQuantity += filledQuantity;
                                
                                config.processedOrderIds.add(orderId);
                                hasNewFilledOrders = true;
                                
                                log(`更新统计数据: 已成交订单=${config.stats.filledOrders}, 成交数量=${config.stats.totalFilledQuantity.toFixed(6)}, 成交金额=${config.stats.totalFilledAmount.toFixed(2)}`);
                            } else {
                                log(`API返回的订单无成交数据: ${JSON.stringify(orderDetails)}`);
                            }
                        }
                    } catch (detailError) {
                        log(`获取订单详情失败: ${detailError.message}`, true);
                    }
                }
            }
            
            // 计算平均价格
            if (config.stats.totalFilledQuantity > 0) {
                config.stats.averagePrice = config.stats.totalFilledAmount / config.stats.totalFilledQuantity;
                log(`更新平均成交价: ${config.stats.averagePrice.toFixed(2)} USDC`);
            }
            
            // 更新上次检查时间
            config.stats.lastUpdateTime = new Date();
            
            // 显示更新后的统计信息
            displayStats();
            
            // 更新未成交订单ID列表
            config.pendingOrderIds = currentPendingOrderIds;
            
            return hasNewFilledOrders || currentStats.filledOrders > 0;
        } else {
            // 如果没有消失的订单，检查是否有任何变化
            const addedOrderIds = [];
            for (const orderId of currentPendingOrderIds) {
                if (!config.pendingOrderIds.has(orderId)) {
                    addedOrderIds.push(orderId);
                }
            }
            
            log(`检测到 ${addedOrderIds.length} 个新订单添加到未成交列表`);
            
            // 如果有新增订单，记录详细信息
            if (addedOrderIds.length > 0) {
                log(`新增订单ID: ${addedOrderIds.join(', ')}`);
            }
            
            // 更新未成交订单ID列表
            config.pendingOrderIds = currentPendingOrderIds;
            
            // 返回是否有成交订单
            return currentStats.filledOrders > 0;
        }
    } catch (error) {
        log(`查询订单历史并更新统计失败: ${error.message}`, true);
        return false;
    }
}

// 检查止盈条件
async function checkTakeProfit(client, symbol, tradingCoin, takeProfitPercentage) {
    try {
        // 首先检查是否有持仓
        const position = await getPosition(client, symbol);
        if (!position || parseFloat(position.quantity) <= 0) {
            log('当前没有持仓，不检查止盈条件');
            return false;
        }

        // 获取当前市场价格
        const ticker = await executeWithRetry(client, client.Ticker, { symbol: symbol });
        const currentPrice = parseFloat(ticker.lastPrice);
        
        // 检查我们是否有实际成交订单的均价数据
        if (isNaN(config.stats.averagePrice) || config.stats.averagePrice <= 0 || config.stats.filledOrders === 0) {
            // 尝试更新均价（只查找本次脚本启动后的订单）
            const statsUpdated = await queryOrdersAndUpdateStats(client, symbol);
            
            if (!statsUpdated || isNaN(config.stats.averagePrice) || config.stats.averagePrice <= 0 || config.stats.filledOrders === 0) {
                // 没有实际成交的买入订单，继续监控但不触发止盈
                log('当前没有实际成交的买入订单，无法计算涨幅，继续监控...');
                log(`当前持仓: ${position.quantity} ${tradingCoin}, 当前价格: ${currentPrice.toFixed(2)} USDC`);
                return false;
            }
        }
        
        // 计算价格涨幅百分比
        const priceIncrease = ((currentPrice - config.stats.averagePrice) / config.stats.averagePrice) * 100;
        const formattedIncrease = priceIncrease.toFixed(2);
        
        // 更新价格信息到全局配置，以便其他函数使用
        config.currentPriceInfo = {
            price: currentPrice,
            increase: priceIncrease,
            updateTime: new Date()
        };
        
        // 详细记录当前情况
        log(`止盈检查: 当前价格=${currentPrice.toFixed(2)} USDC, 实际成交均价=${config.stats.averagePrice.toFixed(2)} USDC, 涨幅=${formattedIncrease}%, 目标=${takeProfitPercentage}%`);
        
        // 判断是否达到止盈条件
        const reachedTakeProfit = priceIncrease >= takeProfitPercentage;
        
        if (reachedTakeProfit) {
            log(`***** 达到止盈条件！当前涨幅 ${formattedIncrease}% 已超过目标 ${takeProfitPercentage}% *****`);
        }
        
        return reachedTakeProfit;
    } catch (error) {
        log(`检查止盈条件失败: ${error.message}`, true);
        if (error.response?.body) {
            log(`错误详情: ${JSON.stringify(error.response.body)}`, true);
        }
        return false;
    }
}

// 市价卖出所有持仓（改为限价单）
async function sellAllPosition(client, symbol, tradingCoin) {
    try {
        // 获取当前持仓情况
        const position = await getPosition(client, symbol);
        if (!position || parseFloat(position.quantity) <= 0) {
            log('没有可卖出的持仓');
            return null;
        }

        // 获取数量精度
        const quantityPrecision = config.quantityPrecisions[tradingCoin] || config.quantityPrecisions.DEFAULT;
        
        // 调整数量精度
        const quantity = adjustQuantityToStepSize(parseFloat(position.quantity), tradingCoin);
        if (quantity <= 0) {
            log('可卖出数量太小，无法执行卖出操作');
            return null;
        }

        // 获取当前市场价格以设置限价
        const ticker = await executeWithRetry(client, client.Ticker, { symbol });
        const currentPrice = parseFloat(ticker.lastPrice);
        
        // 设置卖出价格略低于市场价（确保能够成交），使用正确的价格精度
        const sellPrice = adjustPriceToTickSize(currentPrice * 0.995, tradingCoin);
        
        log(`准备卖出: ${quantity} ${tradingCoin}, 当前市场价=${currentPrice}, 卖出价=${sellPrice}`);

        // 创建限价卖出订单参数
        const orderParams = {
            symbol: symbol,
            side: 'Ask',           // 卖出
            orderType: 'Limit',    // 限价单
            quantity: quantity.toFixed(quantityPrecision),
            price: sellPrice.toString(),  // 使用toString避免可能的自动四舍五入
            timeInForce: 'IOC'     // Immediate-or-Cancel
        };

        // 特殊处理BTC
        if (tradingCoin === 'BTC') {
            log('BTC交易检测，额外调整精度...');
            // 检查数量精度
            const btcQuantityStr = orderParams.quantity;
            if (btcQuantityStr.split('.')[1] && btcQuantityStr.split('.')[1].length > 5) {
                orderParams.quantity = parseFloat(btcQuantityStr).toFixed(5);
                log(`调整BTC数量精度为5位小数: ${orderParams.quantity}`);
            }
            
            // 确保价格是整数
            orderParams.price = Math.floor(parseFloat(orderParams.price)).toString();
            log(`调整BTC价格为整数: ${orderParams.price}`);
        }

        log(`发送限价卖出订单: 币对=${orderParams.symbol}, 价格=${orderParams.price}, 数量=${orderParams.quantity}`);
        const response = await executeWithRetry(client, client.ExecuteOrder, orderParams);
        
        if (response && response.id) {
            log(`卖出订单创建成功: 订单ID=${response.id}, 状态=${response.status}`);
            
            // 检查订单是否完全成交
            let fullyFilled = response.status === 'Filled';
            
            // 如果订单未完全成交，尝试再次以更低价格卖出剩余部分
            if (!fullyFilled) {
                log('订单未完全成交，检查剩余数量并尝试以更低价格卖出');
                
                // 等待一小段时间，让订单有时间处理
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // 获取更新后的持仓
                const updatedPosition = await getPosition(client, symbol);
                if (updatedPosition && parseFloat(updatedPosition.quantity) > 0) {
                    const remainingQuantity = adjustQuantityToStepSize(parseFloat(updatedPosition.quantity), tradingCoin);
                    
                    log(`仍有 ${remainingQuantity} ${tradingCoin} 未售出，尝试以更低价格卖出`);
                    
                    // 更低的价格再次尝试 (原价格的99%)，使用正确的价格精度
                    const lowerSellPrice = adjustPriceToTickSize(currentPrice * 0.99, tradingCoin);
                    
                    const remainingOrderParams = {
                        symbol: symbol,
                        side: 'Ask',
                        orderType: 'Limit',
                        quantity: remainingQuantity.toFixed(quantityPrecision),
                        price: lowerSellPrice.toString(),
                        timeInForce: 'IOC'
                    };
                    
                    // 特殊处理BTC
                    if (tradingCoin === 'BTC') {
                        // 检查数量精度
                        const btcQuantityStr = remainingOrderParams.quantity;
                        if (btcQuantityStr.split('.')[1] && btcQuantityStr.split('.')[1].length > 5) {
                            remainingOrderParams.quantity = parseFloat(btcQuantityStr).toFixed(5);
                            log(`调整BTC数量精度为5位小数: ${remainingOrderParams.quantity}`);
                        }
                        
                        // 确保价格是整数
                        remainingOrderParams.price = Math.floor(parseFloat(remainingOrderParams.price)).toString();
                        log(`调整BTC价格为整数: ${remainingOrderParams.price}`);
                    }
                    
                    log(`发送更低价格的限价卖出订单: 币对=${remainingOrderParams.symbol}, 价格=${remainingOrderParams.price}, 数量=${remainingOrderParams.quantity}`);
                    const secondResponse = await executeWithRetry(client, client.ExecuteOrder, remainingOrderParams);
                    
                    if (secondResponse && secondResponse.id) {
                        log(`第二次卖出订单创建成功: 订单ID=${secondResponse.id}, 状态=${secondResponse.status}`);
                        fullyFilled = secondResponse.status === 'Filled';
                    } else {
                        log('第二次卖出订单创建失败');
                    }
                    
                    // 再次检查是否还有剩余
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    const finalPosition = await getPosition(client, symbol);
                    if (finalPosition && parseFloat(finalPosition.quantity) > 0) {
                        log(`警告: 仍有 ${finalPosition.quantity} ${tradingCoin} 未能售出`);
                    } else {
                        log(`所有 ${tradingCoin} 已售出`);
                        fullyFilled = true;
                    }
                } else {
                    log(`所有 ${tradingCoin} 已售出`);
                    fullyFilled = true;
                }
            }
            
            log(`卖出操作完成，交易${fullyFilled ? '全部' : '部分'}成交`);
            return response;
        } else {
            throw new Error('卖出订单创建失败：响应中没有订单ID');
        }
    } catch (error) {
        log(`卖出失败: ${error.message}`, true);
        if (error.response?.body) {
            log(`错误详情: ${JSON.stringify(error.response.body)}`, true);
        }
        return null;
    }
}

// 获取所有余额的备用方法
async function getAllBalances(client) {
    log('使用备用方法获取余额...');
    
    // 添加整体超时控制，防止永久卡住
    const balancePromise = new Promise(async (resolve, reject) => {
        try {
            // 设置全局超时 - 30秒后不管成功与否都返回结果
            setTimeout(() => {
                log('获取余额操作超时，返回空余额', true);
                resolve([
                    {
                        asset: 'USDC',
                        available: '0',
                        locked: '0',
                        total: '0'
                    }
                ]);
            }, 30000);
            
            // 尝试多种方式获取余额
            try {
                // 方法1: 直接使用privateMethod balanceQuery，添加超时控制
                log('尝试方法1: 使用balanceQuery API...');
                const balanceQueryPromise = client.privateMethod('balanceQuery', {});
                
                // 为API调用添加超时控制
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('API调用超时')), 10000)
                );
                
                // 使用Promise.race让API调用和超时竞争
                const balances = await Promise.race([balanceQueryPromise, timeoutPromise]);
                
                // 检查返回的数据结构，确保它是数组
                if (Array.isArray(balances)) {
                    log('balanceQuery成功获取余额');
                    resolve(balances);
                    return;
                } else if (balances && typeof balances === 'object') {
                    // 如果是对象而不是数组，转换为数组格式
                    log('余额数据是对象格式，转换为数组...');
                    const balancesArray = [];
                    for (const asset in balances) {
                        if (balances.hasOwnProperty(asset)) {
                            balancesArray.push({
                                asset: asset,
                                available: balances[asset].available || '0',
                                locked: balances[asset].locked || '0',
                                total: balances[asset].total || (parseFloat(balances[asset].available || 0) + parseFloat(balances[asset].locked || 0)).toString()
                            });
                        }
                    }
                    log('成功将余额数据转换为数组格式');
                    resolve(balancesArray);
                    return;
                } else {
                    log('balanceQuery返回了意外的数据格式', true);
                    throw new Error('余额数据格式无效');
                }
            } catch (error) {
                log(`备用方法1失败: ${error.message}`, true);
                
                try {
                    // 方法2: 使用Balance API方法，添加超时控制
                    log('尝试方法2: 使用Balance API...');
                    
                    // 为API调用添加超时控制
                    const balancePromise = client.Balance();
                    const timeoutPromise = new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Balance API调用超时')), 10000)
                    );
                    
                    // 使用Promise.race让API调用和超时竞争
                    const balances = await Promise.race([balancePromise, timeoutPromise]);
                    
                    // 检查返回的数据结构
                    if (balances && typeof balances === 'object') {
                        // 转换为数组格式
                        log('Balance API成功获取余额');
                        const balancesArray = [];
                        for (const asset in balances) {
                            if (balances.hasOwnProperty(asset)) {
                                balancesArray.push({
                                    asset: asset,
                                    available: balances[asset].available || '0',
                                    locked: balances[asset].locked || '0',
                                    total: balances[asset].total || (parseFloat(balances[asset].available || 0) + parseFloat(balances[asset].locked || 0)).toString()
                                });
                            }
                        }
                        resolve(balancesArray);
                        return;
                    } else {
                        log('Balance API返回了意外的数据格式', true);
                        throw new Error('余额数据格式无效');
                    }
                } catch (error2) {
                    log(`备用方法2失败: ${error2.message}`, true);
                    
                    // 方法3: 最后的备用 - 返回硬编码的默认余额
                    log('所有API方法获取余额都失败，返回默认余额', true);
                    
                    // 创建一个假的余额对象，只包含我们需要查询的币种，数量设为0
                    const symbol = config.symbol || '';
                    const tradingCoin = symbol.split('_')[0];
                    let defaultBalances;
                    
                    if (!tradingCoin) {
                        log('使用硬编码默认余额（BTC和USDC）', true);
                        defaultBalances = [
                            {
                                asset: 'BTC',
                                available: '0',
                                locked: '0',
                                total: '0'
                            },
                            {
                                asset: 'USDC',
                                available: '0',
                                locked: '0', 
                                total: '0'
                            }
                        ];
                    } else {
                        log(`使用硬编码方法创建余额信息，币种: ${tradingCoin}`, true);
                        defaultBalances = [
                            {
                                asset: tradingCoin,
                                available: '0',
                                locked: '0',
                                total: '0'
                            },
                            {
                                asset: 'USDC',
                                available: '0',
                                locked: '0', 
                                total: '0'
                            }
                        ];
                    }
                    
                    resolve(defaultBalances);
                    return;
                }
            }
        } catch (finalError) {
            log(`获取余额时发生严重错误: ${finalError.message}`, true);
            // 确保有返回值，即使发生错误
            resolve([
                {
                    asset: 'USDC',
                    available: '0',
                    locked: '0', 
                    total: '0'
                }
            ]);
        }
    });
    
    return await balancePromise;
}

// 显示账户余额信息
async function displayBalances(client) {
    try {
        log('\n=== 账户余额信息 ===');
        
        // 添加整体超时控制
        const timeoutPromise = new Promise(resolve => {
            setTimeout(() => {
                log('显示余额操作超时', true);
                resolve([]);
            }, 60000); // 60秒后超时
        });
        
        // 获取余额信息并添加超时控制
        const balancesPromise = getAllBalances(client);
        const balances = await Promise.race([balancesPromise, timeoutPromise]);
        
        if (balances && balances.length > 0) {
            // 获取USDC价格信息，用于计算其他币种的价值
            let usdcPrices = {};
            const pricePromises = [];
            const nonUsdcAssets = balances.filter(b => b.asset !== 'USDC');
            
            // 限制最多同时查询5个价格，避免API过载
            const MAX_CONCURRENT_PRICE_QUERIES = 5;
            const assetChunks = [];
            
            // 分批处理资产
            for (let i = 0; i < nonUsdcAssets.length; i += MAX_CONCURRENT_PRICE_QUERIES) {
                assetChunks.push(nonUsdcAssets.slice(i, i + MAX_CONCURRENT_PRICE_QUERIES));
            }
            
            // 批量处理每组资产的价格查询
            for (const chunk of assetChunks) {
                const chunkPromises = chunk.map(balance => {
                    return new Promise(async (resolve) => {
                        try {
                            const symbol = `${balance.asset}_USDC`;
                            // 为每个价格查询添加5秒超时
                            const tickerPromise = executeWithRetry(client, client.Ticker, { symbol });
                            const timeoutPromise = new Promise((_, reject) => 
                                setTimeout(() => reject(new Error(`获取${balance.asset}价格超时`)), 5000)
                            );
                            
                            const ticker = await Promise.race([tickerPromise, timeoutPromise]);
                            usdcPrices[balance.asset] = parseFloat(ticker.lastPrice);
                            log(`获取${balance.asset}价格成功: ${usdcPrices[balance.asset]} USDC`);
                        } catch (error) {
                            log(`获取${balance.asset}价格失败: ${error.message}`, true);
                            usdcPrices[balance.asset] = 0;
                        }
                        resolve();
                    });
                });
                
                // 等待当前批次的所有价格查询完成
                await Promise.all(chunkPromises);
                
                // 添加短暂延迟避免API限流
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            let totalUsdcValue = 0;
            log('币种\t总余额\t可用余额\t冻结余额\t估计价值(USDC)');
            log('----------------------------------------------------------');
            
            for (const balance of balances) {
                const total = parseFloat(balance.total);
                const available = parseFloat(balance.available);
                const locked = parseFloat(balance.locked);
                
                let usdcValue = 0;
                if (balance.asset === 'USDC') {
                    usdcValue = total;
                } else if (usdcPrices[balance.asset]) {
                    usdcValue = total * usdcPrices[balance.asset];
                }
                
                totalUsdcValue += usdcValue;
                
                log(`${balance.asset}\t${total.toFixed(6)}\t${available.toFixed(6)}\t${locked.toFixed(6)}\t${usdcValue.toFixed(2)}`);
            }
            
            log('----------------------------------------------------------');
            log(`总价值: ${totalUsdcValue.toFixed(2)} USDC`);
            return balances;
        } else {
            log('未找到任何币种的余额信息');
            return [];
        }
    } catch (error) {
        log(`显示账户余额失败: ${error.message}`, true);
        // 继续程序执行，不要因为余额显示失败而中断
        log('继续执行程序...');
        return [];
    }
}

// 卖出所有非USDC币种
async function sellAllNonUsdcAssets(client, minValueRequired = 10) {
    try {
        log('\n=== 卖出所有非USDC币种 ===');
        const balances = await getAllBalances(client);
        
        if (!balances || balances.length === 0) {
            log('没有找到任何余额信息');
            return;
        }
        
        const nonUsdcBalances = balances.filter(b => b.asset !== 'USDC' && parseFloat(b.available) > 0);
        if (nonUsdcBalances.length === 0) {
            log('没有可供卖出的非USDC币种');
            return;
        }
        
        // 首先筛选出价值大于等于minValueRequired的币种
        const valuableBalances = [];
        for (const balance of nonUsdcBalances) {
            try {
                // 获取当前市场价格
                const symbol = `${balance.asset}_USDC`;
                let ticker;
                try {
                    ticker = await executeWithRetry(client, client.Ticker, { symbol });
                } catch (error) {
                    log(`获取 ${symbol} 价格失败，跳过此币种: ${error.message}`, true);
                    continue;
                }
                
                const currentPrice = parseFloat(ticker.lastPrice);
                const available = parseFloat(balance.available);
                const assetValue = available * currentPrice;
                
                log(`${balance.asset}: 可用余额=${available}, 当前价格=${currentPrice} USDC, 价值=${assetValue.toFixed(2)} USDC`);
                
                // 如果价值小于最小要求，则跳过
                if (assetValue < minValueRequired) {
                    log(`${balance.asset} 价值小于 ${minValueRequired} USDC，跳过卖出`);
                    continue;
                }
                
                valuableBalances.push({
                    ...balance,
                    currentPrice,
                    value: assetValue
                });
            } catch (error) {
                log(`检查 ${balance.asset} 价值时出错: ${error.message}`, true);
            }
        }
        
        if (valuableBalances.length === 0) {
            log(`没有价值大于等于 ${minValueRequired} USDC 的非USDC币种，跳过卖出`);
            return;
        }
        
        log(`发现 ${valuableBalances.length} 个价值大于等于 ${minValueRequired} USDC 的非USDC币种可供卖出`);
        
        for (const balance of valuableBalances) {
            try {
                // 获取该币种的数量精度
                const quantityPrecision = config.quantityPrecisions[balance.asset] || config.quantityPrecisions.DEFAULT;
                
                // 调整数量精度
                const quantity = adjustQuantityToStepSize(parseFloat(balance.available), balance.asset);
                
                // 检查是否有足够的数量
                if (quantity <= 0) {
                    log(`${balance.asset}: 调整精度后数量为零，跳过卖出`);
                    continue;
                }
                
                // 使用正确的价格精度
                const sellPrice = adjustPriceToTickSize(balance.currentPrice * 0.995, balance.asset);
                
                log(`${balance.asset}: 准备卖出数量=${quantity}, 调整后价格=${sellPrice} USDC`);
                
                // 创建限价卖出订单，确保价格和数量精度正确
                const orderParams = {
                    symbol: `${balance.asset}_USDC`,
                    side: 'Ask',           // 卖出
                    orderType: 'Limit',    // 限价单
                    quantity: quantity.toFixed(quantityPrecision),
                    price: sellPrice.toString(),  // 使用toString而不是toFixed，避免自动四舍五入
                    timeInForce: 'IOC'     // Immediate-or-Cancel
                };
                
                // 特殊处理BTC
                if (balance.asset === 'BTC') {
                    log('BTC交易检测，额外调整精度...');
                    // 检查数量精度
                    const btcQuantityStr = orderParams.quantity;
                    if (btcQuantityStr.split('.')[1] && btcQuantityStr.split('.')[1].length > 5) {
                        orderParams.quantity = parseFloat(btcQuantityStr).toFixed(5);
                        log(`调整BTC数量精度为5位小数: ${orderParams.quantity}`);
                    }
                    
                    // 确保价格是整数
                    orderParams.price = Math.floor(parseFloat(orderParams.price)).toString();
                    log(`调整BTC价格为整数: ${orderParams.price}`);
                }
                
                log(`发送限价卖出订单: ${JSON.stringify(orderParams)}`);
                
                const response = await executeWithRetry(client, client.ExecuteOrder, orderParams);
                
                if (response && response.id) {
                    log(`卖出 ${balance.asset} 成功: 订单ID=${response.id}, 状态=${response.status || '未知'}`);
                    
                    // 检查是否完全成交
                    if (response.status !== 'Filled') {
                        log(`订单未完全成交，尝试以更低价格卖出剩余部分`);
                        
                        // 等待一小段时间
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        // 检查剩余余额
                        const updatedBalances = await getAllBalances(client);
                        const updatedBalance = updatedBalances.find(b => b.asset === balance.asset);
                        
                        if (updatedBalance && parseFloat(updatedBalance.available) > 0) {
                            // 调整数量精度
                            const remainingQuantity = adjustQuantityToStepSize(parseFloat(updatedBalance.available), balance.asset);
                            
                            if (remainingQuantity > 0) {
                                log(`仍有 ${remainingQuantity} ${balance.asset} 未卖出，尝试更低价格`);
                                
                                // 使用更低的价格重试
                                const lowerSellPrice = adjustPriceToTickSize(balance.currentPrice * 0.99, balance.asset);
                                
                                const retryOrderParams = {
                                    symbol: `${balance.asset}_USDC`,
                                    side: 'Ask',
                                    orderType: 'Limit',
                                    quantity: remainingQuantity.toFixed(quantityPrecision),
                                    price: lowerSellPrice.toString(),
                                    timeInForce: 'IOC'
                                };
                                
                                // 特殊处理BTC
                                if (balance.asset === 'BTC') {
                                    // 检查数量精度
                                    const btcQuantityStr = retryOrderParams.quantity;
                                    if (btcQuantityStr.split('.')[1] && btcQuantityStr.split('.')[1].length > 5) {
                                        retryOrderParams.quantity = parseFloat(btcQuantityStr).toFixed(5);
                                        log(`调整BTC数量精度为5位小数: ${retryOrderParams.quantity}`);
                                    }
                                    
                                    // 确保价格是整数
                                    retryOrderParams.price = Math.floor(parseFloat(retryOrderParams.price)).toString();
                                    log(`调整BTC价格为整数: ${retryOrderParams.price}`);
                                }
                                
                                log(`发送更低价格的限价卖出订单: 币对=${retryOrderParams.symbol}, 价格=${retryOrderParams.price}, 数量=${retryOrderParams.quantity}`);
                                const retryResponse = await executeWithRetry(client, client.ExecuteOrder, retryOrderParams);
                                
                                if (retryResponse && retryResponse.id) {
                                    log(`第二次卖出 ${balance.asset} 成功: 订单ID=${retryResponse.id}`);
                                } else {
                                    log(`第二次卖出 ${balance.asset} 失败`);
                                }
                            }
                        } else {
                            log(`所有 ${balance.asset} 已售出或无法获取最新余额`);
                        }
                    }
                } else {
                    log(`卖出 ${balance.asset} 失败: 响应中没有订单ID`);
                }
                
                // 添加延迟避免API限制
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                log(`卖出 ${balance.asset} 失败: ${error.message}`, true);
                if (error.response?.body) {
                    log(`错误详情: ${JSON.stringify(error.response.body)}`, true);
                }
                // 继续处理其他币种，不中断流程
            }
        }
        
        log('所有非USDC币种卖出操作完成');
        
    } catch (error) {
        log(`卖出所有非USDC币种失败: ${error.message}`, true);
    }
}

// 设置WebSocket连接获取实时价格 - 基于test_websocket2.js
function setupPriceWebSocket(symbol) {
    try {
        // 如果已经在进行重连，则跳过
        if (wsReconnecting) {
            log(`WebSocket已在重连过程中，跳过此次连接尝试...`);
            return null;
        }
        
        wsReconnecting = true;
        log(`建立WebSocket连接获取${symbol}实时价格...`);
        
        // 关闭现有连接
        if (priceWebSocket && priceWebSocket.readyState === WebSocket.OPEN) {
            log('关闭现有WebSocket连接...');
            priceWebSocket.close();
        }
        
        // 连接到Backpack WebSocket API
        log(`建立到Backpack的WebSocket连接 ${WS_URL}...`);
        priceWebSocket = new WebSocket(WS_URL);
        
        // WebSocket打开时
        priceWebSocket.onopen = () => {
            log('WebSocket连接已建立 - 准备发送订阅请求');
            wsConnected = true;
            wsReconnectAttempts = 0;
            wsReconnecting = false; // 连接成功，重置重连标志
            log('WebSocket连接已建立');
            
            // 订阅ticker数据 - 尝试多种可能的格式
            // Backpack交易所的WebSocket API可能需要特定的格式
            const tickerChannel = `ticker.${symbol.toUpperCase()}`;
            const subscriptionData = {
                method: "SUBSCRIBE",
                params: [tickerChannel],
                id: Date.now()
            };
            log(`订阅ticker数据: ${JSON.stringify(subscriptionData)}`);
            priceWebSocket.send(JSON.stringify(subscriptionData));
            
            // 设置心跳
            setupWebSocketHeartbeat();
            
            // 初始化日志控制
            resetWsLogControl();
        };
        
        // 处理接收到的消息
        priceWebSocket.onmessage = (event) => {
            try {
                const now = Date.now();
                let data;
                let isErrorMessage = false;
                
                try {
                    data = JSON.parse(event.data);
                } catch (parseError) {
                    // JSON解析错误，视为错误消息
                    isErrorMessage = true;
                    logToFile(`WebSocket消息解析错误: ${parseError.message}, 原始消息: ${event.data.substring(0, 200)}...`, true);
                }
                
                // 处理错误消息和非错误消息
                if (isErrorMessage) {
                    // 错误消息总是记录
                    logToFile(`收到无法解析的WebSocket消息: ${event.data.substring(0, 200)}...`, true);
                } else {
                    // 非错误消息，根据监控周期控制日志输出
                    wsLogControl.logCount++;
                    
                    // 只有在本监控周期尚未记录日志的情况下，且是价格相关消息才记录
                    const isPriceMessage = data.e === 'ticker' || 
                                          (data.stream && data.stream.includes('ticker')) || 
                                          (data.data && data.data.e === 'ticker');
                    
                    if (!wsLogControl.loggedThisCycle && isPriceMessage) {
                        logToFile(`收到WebSocket消息: ${event.data.substring(0, 200)}...`);
                        logToFile(`WebSocket消息类型: ${JSON.stringify(Object.keys(data))}`);
                        
                        if (data.stream && data.stream.includes('ticker') && data.data) {
                            logToFile(`收到stream格式ticker数据: ${JSON.stringify(data.data).substring(0, 100)}...`);
                        }
                        
                        wsLogControl.loggedThisCycle = true;
                        wsLogControl.lastLogTime = now;
                    }
                    
                    // 心跳响应只记录一次
                    if (data.result === "PONG" || (data.id && data.result === "PONG")) {
                        if (now - wsLogControl.lastLogTime > 60000) { // 每分钟最多记录一次心跳
                            logToFile('收到WebSocket PONG响应');
                            wsLogControl.lastLogTime = now;
                        }
                    }
                    
                    // 处理ticker数据 - Backpack格式可能是e='ticker'或其他
                    if (data.e === 'ticker') {
                        const tickerSymbol = data.s; // 交易对
                        const lastPrice = parseFloat(data.c); // 最新价格
                        
                        // 检查是否是我们关注的交易对，忽略大小写进行比较
                        if (tickerSymbol.toUpperCase() === symbol.toUpperCase()) {
                            // 限制价格更新消息的显示频率（每30秒最多显示一次）
                            if (now - lastPriceLogTime > 30000 || lastPrice !== lastWebSocketPriceValue) {
                                // 价格更新信息在终端显示
                                log(`价格更新：${tickerSymbol} = ${lastPrice} USDC`);
                                lastPriceLogTime = now;
                                lastWebSocketPriceValue = lastPrice;
                            }
                            
                            // 计算涨幅
                            const averagePrice = config.stats.averagePrice;
                            let priceIncrease = 0;
                            
                            if (averagePrice > 0) {
                                priceIncrease = (lastPrice - averagePrice) / averagePrice * 100;
                            }
                            
                            // 更新价格信息
                            config.currentPriceInfo = {
                                price: lastPrice,
                                increase: priceIncrease,
                                updateTime: new Date(),
                                source: 'WebSocket'
                            };
                            
                            // 更新显示（降低频率，从15秒改为60秒更新一次）
                            const currentTime = Date.now();
                            if (!config.lastDisplayUpdate || (currentTime - config.lastDisplayUpdate) > 60000) {
                                displayAccountInfo();
                                config.lastDisplayUpdate = currentTime;
                            }
                        }
                    }
                    // 尝试处理其他可能的价格数据格式
                    else if (data.stream && data.stream.includes('ticker') && data.data) {
                        // 处理stream格式的消息，常见于某些交易所
                        const tickerData = data.data;
                        if (tickerData.s && tickerData.c) {
                            const tickerSymbol = tickerData.s;
                            const lastPrice = parseFloat(tickerData.c);
                            
                            if (tickerSymbol.toUpperCase() === symbol.toUpperCase()) {
                                // 限制价格更新消息的显示频率
                                if (now - lastPriceLogTime > 30000 || lastPrice !== lastWebSocketPriceValue) {
                                    // 价格更新信息在终端显示
                                    log(`价格更新：${tickerSymbol} = ${lastPrice} USDC`);
                                    lastPriceLogTime = now;
                                    lastWebSocketPriceValue = lastPrice;
                                }
                                
                                // 计算涨幅和更新价格信息
                                const averagePrice = config.stats.averagePrice;
                                let priceIncrease = 0;
                                
                                if (averagePrice > 0) {
                                    priceIncrease = (lastPrice - averagePrice) / averagePrice * 100;
                                }
                                
                                config.currentPriceInfo = {
                                    price: lastPrice,
                                    increase: priceIncrease,
                                    updateTime: new Date(),
                                    source: 'WebSocket'
                                };
                                
                                // 更新显示（降低频率更新）
                                const currentTime = Date.now();
                                if (!config.lastDisplayUpdate || (currentTime - config.lastDisplayUpdate) > 60000) {
                                    displayAccountInfo();
                                    config.lastDisplayUpdate = currentTime;
                                }
                            }
                        }
                    }
                    // 处理普通的价格数据格式 - 适用于大多数交易所
                    else if (data.symbol && data.price) {
                        const tickerSymbol = data.symbol;
                        const lastPrice = parseFloat(data.price);
                        
                        if (tickerSymbol.toUpperCase() === symbol.toUpperCase()) {
                            // 限制价格更新消息的显示频率
                            if (now - lastPriceLogTime > 30000 || lastPrice !== lastWebSocketPriceValue) {
                                // 价格更新信息在终端显示
                                log(`价格更新：${tickerSymbol} = ${lastPrice} USDC`);
                                lastPriceLogTime = now;
                                lastWebSocketPriceValue = lastPrice;
                            }
                            
                            // 更新价格信息
                            const averagePrice = config.stats.averagePrice;
                            let priceIncrease = 0;
                            
                            if (averagePrice > 0) {
                                priceIncrease = (lastPrice - averagePrice) / averagePrice * 100;
                            }
                            
                            config.currentPriceInfo = {
                                price: lastPrice,
                                increase: priceIncrease,
                                updateTime: new Date(),
                                source: 'WebSocket'
                            };
                            
                            // 更新显示（降低频率）
                            const currentTime = Date.now();
                            if (!config.lastDisplayUpdate || (currentTime - config.lastDisplayUpdate) > 60000) {
                                displayAccountInfo();
                                config.lastDisplayUpdate = currentTime;
                            }
                        }
                    }
                    
                    // 处理订阅成功
                    if (data.result === null && data.id) {
                        log(`WebSocket订阅成功，ID: ${data.id}`);
                        
                        // 尝试发送一个测试消息请求最新价格
                        setTimeout(() => {
                            try {
                                if (priceWebSocket && priceWebSocket.readyState === WebSocket.OPEN) {
                                    const getTickerMsg = JSON.stringify({
                                        method: "GET_TICKER",
                                        params: {
                                            symbol: symbol.toUpperCase()
                                        },
                                        id: Date.now()
                                    });
                                    logToFile(`尝试请求当前价格数据: ${getTickerMsg}`);
                                    priceWebSocket.send(getTickerMsg);
                                }
                            } catch (e) {
                                log(`发送价格请求失败: ${e.message}`);
                            }
                        }, 2000);
                    }
                }
            } catch (error) {
                log(`WebSocket消息处理错误: ${error.message}`, true);
                logToFile(`原始消息: ${event.data}`);
            }
        };
        
        // 处理错误
        priceWebSocket.onerror = (error) => {
            log(`WebSocket错误: ${error.message || '未知错误'}`, true);
            wsConnected = false;
        };
        
        // 连接关闭时
        priceWebSocket.onclose = (event) => {
            logToFile(`WebSocket连接已关闭，代码: ${event.code}, 原因: ${event.reason}`);
            wsConnected = false;
            
            // 重连逻辑 - 只有在程序未主动关闭连接时才重连
            if (!wsReconnecting && wsReconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                wsReconnectAttempts++;
                const reconnectDelay = Math.pow(2, wsReconnectAttempts) * 1000; // 指数退避
                log(`尝试在 ${reconnectDelay/1000} 秒后重新连接WebSocket (尝试 ${wsReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                
                setTimeout(() => {
                    setupPriceWebSocket(symbol);
                }, reconnectDelay);
            } else if (wsReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                log('达到最大重连次数，不再尝试WebSocket连接');
                wsReconnecting = false; // 重置状态以便将来可以手动重连
            }
        };
        
        return priceWebSocket;
    } catch (error) {
        logToFile(`设置WebSocket时出错: ${error.message}`, true);
        wsConnected = false;
        wsReconnecting = false; // 出错时也要重置状态
        return null;
    }
}

// 设置WebSocket心跳
function setupWebSocketHeartbeat() {
    const heartbeatInterval = setInterval(() => {
        if (priceWebSocket && priceWebSocket.readyState === WebSocket.OPEN) {
            try {
                // 根据文档使用正确的心跳格式
                const heartbeatMsg = JSON.stringify({
                    method: "PING",
                    id: Date.now()
                });
                
                priceWebSocket.send(heartbeatMsg);
                // 心跳消息只记录到日志文件，不显示在终端
                logToFile(`WebSocket发送心跳: ${heartbeatMsg}`);
            } catch (error) {
                logToFile(`发送心跳时出错: ${error.message}`, true);
                clearInterval(heartbeatInterval);
            }
        } else {
            clearInterval(heartbeatInterval);
        }
    }, 20000); // 每20秒发送一次心跳
    
    // 将心跳间隔保存到全局变量，以便在脚本结束时清除
    config.heartbeatInterval = heartbeatInterval;
}

// 关闭WebSocket连接
function closeWebSocket() {
    try {
        // 先设置标志，防止自动重连
        wsReconnecting = true;
        
        if (priceWebSocket) {
            log('尝试关闭WebSocket连接...');
            
            // 根据当前连接状态采取不同操作
            const readyState = priceWebSocket.readyState;
            switch (readyState) {
                case WebSocket.CONNECTING: // 0
                    log('WebSocket正在连接中，中断连接...');
                    break;
                case WebSocket.OPEN: // 1
                    log('WebSocket连接已打开，正常关闭...');
                    priceWebSocket.close(1000, '正常关闭');
                    break;
                case WebSocket.CLOSING: // 2
                    log('WebSocket连接正在关闭中...');
                    break;
                case WebSocket.CLOSED: // 3
                    log('WebSocket连接已关闭');
                    break;
                default:
                    log(`WebSocket处于未知状态: ${readyState}`);
            }
            
            // 无论状态如何，确保资源被释放
            priceWebSocket = null;
        } else {
            log('没有活动的WebSocket连接需要关闭');
        }
        
        // 重置连接状态
        wsConnected = false;
        
        // 清除心跳
        if (config.heartbeatInterval) {
            log('清除WebSocket心跳定时器');
            clearInterval(config.heartbeatInterval);
            config.heartbeatInterval = null;
        }
        
        // 在关闭后适当延迟，重置重连标志
        log('等待3秒后重置WebSocket重连标志...');
        setTimeout(() => {
            log('重置WebSocket重连标志和计数');
            wsReconnecting = false;
            wsReconnectAttempts = 0;
        }, 3000);
        
        log('WebSocket资源释放完成');
    } catch (error) {
        log(`关闭WebSocket时出错: ${error.message}`, true);
        log(`错误堆栈: ${error.stack || '无堆栈信息'}`, true);
        
        // 确保即使出错，状态也会被重置
        priceWebSocket = null;
        wsConnected = false;
        wsReconnecting = false;
        wsReconnectAttempts = 0;
        
        if (config.heartbeatInterval) {
            clearInterval(config.heartbeatInterval);
            config.heartbeatInterval = null;
        }
    }
}

// 订单查询优化：减少频率，使用缓存
async function efficientOrderQuery(client, symbol) {
  // 使用缓存机制减少API调用
  // 只有在必要时才发起新的查询
}

// 余额查询优化：仅保留最稳定的方法
async function getBalances(client) {
  // 直接使用最可靠的Balance API
  return await client.Balance();
}

// 主函数 - 现在变成一个可以循环运行的函数
async function main() {
    try {
        log('=== Backpack 自动化递增买入系统启动 ===');
        log(`脚本启动时间: ${config.scriptStartTime.toLocaleString()}`);
        
        // 记录初始状态信息
        log(`初始状态 - 已创建订单ID: ${config.allCreatedOrderIds.size}, 已处理订单ID: ${config.processedOrderIds.size}`);
        log(`初始统计数据 - 已成交订单: ${config.stats.filledOrders}, 成交金额: ${config.stats.totalFilledAmount.toFixed(2)}, 成交数量: ${config.stats.totalFilledQuantity.toFixed(6)}`);
        
        // 不再重新加载配置文件
        log('使用启动时配置');
        
        // 初始化客户端
        const client = new BackpackClient(config.privateKey, config.publicKey);
        log('API客户端初始化成功');
        
        // 获取交易币种
        const tradingCoin = await question('请输入交易币种 (例如: BTC, SOL): ');
        const symbol = `${tradingCoin}_USDC`;
        log(`选择的交易对: ${symbol}`);
        
        // 保存交易币对到全局配置，方便其他函数使用
        config.symbol = symbol;
        
        // 启动WebSocket连接获取实时价格 (新增)
        log('启动WebSocket获取实时价格...');
        setupPriceWebSocket(symbol);
        
        // 询问是否撤销该交易对的所有未完成订单
        const cancelConfirm = await question(`\n是否撤销 ${symbol} 交易对的所有未完成订单? (y/n): `);
        if (cancelConfirm.toLowerCase() === 'y') {
            log(`开始撤销 ${symbol} 交易对的所有未完成订单...`);
            await cancelAllOrders(client);
        }
        
        // 获取当前市场价格
        const ticker = await executeWithRetry(client, client.Ticker, { symbol: symbol });
        const currentPrice = parseFloat(ticker.lastPrice);
        log(`当前市场价格: ${currentPrice} USDC`);
        
        // 根据币种获取最小交易量和数量精度
        const minQuantity = config.minQuantities[tradingCoin] || config.minQuantities.DEFAULT;
        const quantityPrecision = config.quantityPrecisions[tradingCoin] || config.quantityPrecisions.DEFAULT;
        log(`最小交易量: ${minQuantity} ${tradingCoin}`);
        log(`数量精度: ${quantityPrecision} 位小数`);
        
        // 根据当前价格动态调整最小订单金额
        const minOrderAmount = Math.max(config.minOrderAmount, currentPrice * minQuantity);
        log(`当前最小订单金额: ${minOrderAmount.toFixed(2)} USDC`);
        
        // 获取交易参数
        const maxDropPercentage = parseFloat(await question('请输入最大跌幅百分比 (例如: 5): '));
        const totalAmount = parseFloat(await question('请输入总投资金额 (USDC): '));
        const orderCount = parseInt(await question('请输入买入次数: '));
        const incrementPercentage = parseFloat(await question('请输入每次金额增加的百分比 (例如: 10): '));
        const takeProfitPercentage = parseFloat(await question('请输入止盈百分比 (例如: 5): '));
        
        // 验证输入
        if (totalAmount < minOrderAmount * orderCount) {
            throw new Error(`总投资金额太小，无法创建 ${orderCount} 个订单（每个订单最小金额: ${minOrderAmount.toFixed(2)} USDC）`);
        }
        
        // 计算订单
        const orders = calculateIncrementalOrders(
            currentPrice,
            maxDropPercentage,
            totalAmount,
            orderCount,
            incrementPercentage,
            minOrderAmount,
            tradingCoin
        );
        
        // 显示计划创建的订单
        log('\n=== 计划创建的订单 ===');
        let totalOrderAmount = 0;
        orders.forEach((order, index) => {
            log(`订单 ${index + 1}: 价格=${order.price} USDC, 数量=${order.quantity} ${tradingCoin}, 金额=${order.amount} USDC`);
            totalOrderAmount += order.amount;
        });
        log(`总订单金额: ${totalOrderAmount.toFixed(2)} USDC`);
        
        // 确认是否继续
        const confirm = await question('\n是否继续创建订单? (y/n): ');
        if (confirm.toLowerCase() !== 'y') {
            log('用户取消操作');
            return false; // 返回false表示不需要重启
        }
        
        // 创建订单
        log('\n=== 开始创建订单 ===');
        let successCount = 0;
        
        // 重置统计信息以确保干净的数据
        config.stats = {
            totalOrders: 0,
            filledOrders: 0,
            totalFilledAmount: 0,
            totalFilledQuantity: 0,
            averagePrice: 0,
            lastUpdateTime: null
        };
        
        // 清空已处理订单ID集合
        config.processedOrderIds = new Set();
        
        // 保存计划创建的订单总数
        const plannedOrderCount = orders.length;
        
        // 创建订单前先清空订单签名集合
        config.createdOrderSignatures = new Set();
        
        // 创建订单循环
        let retryAttempts = 0;
        const MAX_RETRY_ATTEMPTS = 5;
        let createdOrdersCount = 0; // 跟踪实际创建的订单数量
        
        while (successCount < plannedOrderCount && retryAttempts < MAX_RETRY_ATTEMPTS) {
            // 如果是重试，展示重试信息
            if (retryAttempts > 0) {
                log(`\n===== 自动重试创建订单 (第 ${retryAttempts}/${MAX_RETRY_ATTEMPTS} 次) =====`);
                log(`已成功创建 ${successCount}/${plannedOrderCount} 个订单，继续尝试创建剩余订单...`);
            }
            
            // 只处理未成功创建的订单
            const remainingOrders = orders.slice(successCount);
            
            for (const order of remainingOrders) {
                try {
                    const response = await createBuyOrder(client, symbol, order.price, order.quantity, tradingCoin);
                    
                    // 如果是跳过的重复订单，不增加成功计数
                    if (response && response.skipped) {
                        log(`跳过了重复订单，不增加成功计数`);
                        continue;
                    }
                    
                    successCount++;
                    createdOrdersCount++; // 跟踪实际创建的订单数量
                    log(`成功创建第 ${successCount}/${plannedOrderCount} 个订单`);
                    
                    // 检查是否已创建足够数量的订单
                    if (createdOrdersCount >= plannedOrderCount) {
                        log(`已达到计划创建的订单数量: ${plannedOrderCount}`);
                        break;
                    }
                    
                    // 添加延迟避免API限制
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } catch (error) {
                    log(`创建订单失败: ${error.message}`, true);
                    // 如果是资金不足，跳过后续订单
                    if (error.message.includes('Insufficient') || error.message.includes('insufficient')) {
                        log('资金不足，停止创建更多订单', true);
                        break;
                    } else {
                        // 其他错误，等待后继续尝试
                        const waitTime = Math.min(3000 * (retryAttempts + 1), 15000); // 随重试次数增加等待时间
                        log(`等待${waitTime/1000}秒后自动重试...`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    }
                }
            }
            
            // 检查是否已创建足够数量的订单（整体检查）
            if (createdOrdersCount >= plannedOrderCount) {
                log(`✓ 已创建所有计划的 ${plannedOrderCount} 个订单！`);
                break;
            }
            
            // 如果所有订单都创建成功，跳出循环
            if (successCount >= plannedOrderCount) {
                log(`✓ 成功创建所有 ${plannedOrderCount} 个订单！`);
                break;
            }
            
            // 增加重试次数
            retryAttempts++;
            
            // 如果还未达到最大重试次数，自动继续尝试
            if (successCount < plannedOrderCount && retryAttempts < MAX_RETRY_ATTEMPTS) {
                // 添加随重试次数增加的等待时间
                const waitTime = 5000 * retryAttempts;
                log(`将在${waitTime/1000}秒后自动重试创建剩余订单...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
        
        // 所有订单创建完成后，再显示账户余额
        log('\n=== 订单创建完成，获取账户余额 ===');
        // 显示账户余额，添加超时和异常处理
        try {
            const balancePromise = displayBalances(client);
            const timeoutPromise = new Promise(resolve => {
                setTimeout(() => {
                    log('获取余额操作超时，继续执行程序', true);
                    resolve([]);
                }, 90000); // 90秒总超时
            });
            
            await Promise.race([balancePromise, timeoutPromise]);
        } catch (balanceError) {
            log(`获取账户余额失败: ${balanceError.message}，继续执行程序`, true);
        }

        // 在创建订单后立即初始化pending订单记录，确保能正确跟踪所有订单
        try {
            log('初始化未成交订单跟踪...');
            // 获取当前所有未成交订单
            const initialOpenOrders = await executeWithRetry(client, client.GetOpenOrders, { symbol });
            
            // 统计已创建但不在未成交列表中的订单（可能是创建过程中已成交的订单）
            const currentPendingOrderIds = new Set(initialOpenOrders.map(order => order.id));
            const potentiallyFilledOrderIds = new Set();
            
            for (const orderId of config.allCreatedOrderIds) {
                if (!currentPendingOrderIds.has(orderId)) {
                    potentiallyFilledOrderIds.add(orderId);
                }
            }
            
            if (potentiallyFilledOrderIds.size > 0) {
                log(`警告: 检测到 ${potentiallyFilledOrderIds.size} 个已创建订单不在未成交列表中，可能已成交`);
                log(`已创建订单数: ${config.allCreatedOrderIds.size}, 当前未成交订单数: ${currentPendingOrderIds.size}`);
                log(`疑似已成交的订单ID: ${Array.from(potentiallyFilledOrderIds).join(', ')}`);
                
                // 手动处理疑似已成交的订单前记录当前统计状态
                log(`处理前统计数据 - 已成交订单: ${config.stats.filledOrders}, 成交金额: ${config.stats.totalFilledAmount.toFixed(2)}, 成交数量: ${config.stats.totalFilledQuantity.toFixed(6)}`);
                
                // 手动处理疑似已成交的订单
                for (const orderId of potentiallyFilledOrderIds) {
                    if (config.processedOrderIds.has(orderId)) {
                        log(`订单ID ${orderId} 已处理过，跳过`);
                        continue;
                    }
                    
                    log(`处理可能已成交的订单: ${orderId}`);
                    const orderInfo = config.createdOrders[orderId];
                    
                    if (orderInfo) {
                        log(`使用创建时记录的订单信息: 价格=${orderInfo.price}, 数量=${orderInfo.quantity}, 金额=${orderInfo.amount.toFixed(2)}`);
                        
                        // 更新统计信息
                        config.stats.filledOrders++;
                        config.stats.totalFilledAmount += orderInfo.amount;
                        config.stats.totalFilledQuantity += orderInfo.quantity;
                        
                        // 标记为已处理
                        config.processedOrderIds.add(orderId);
                        orderInfo.processed = true;
                        
                        log(`更新统计数据: 已成交订单=${config.stats.filledOrders}, 成交数量=${config.stats.totalFilledQuantity.toFixed(6)}, 成交金额=${config.stats.totalFilledAmount.toFixed(2)}`);
                    } else {
                        log(`未找到订单ID ${orderId} 的创建记录，尝试通过API获取详细信息`);
                        try {
                            const orderDetails = await client.privateMethod('orderDetail', { orderId: orderId });
                            if (orderDetails && orderDetails.status === 'Filled') {
                                const filledQuantity = parseFloat(orderDetails.executedQuantity || 0);
                                const filledAmount = parseFloat(orderDetails.executedQuoteQuantity || 0);
                                
                                log(`API返回已成交订单: 价格=${orderDetails.price}, 成交数量=${filledQuantity}, 成交金额=${filledAmount}`);
                                
                                config.stats.filledOrders++;
                                config.stats.totalFilledAmount += filledAmount;
                                config.stats.totalFilledQuantity += filledQuantity;
                                
                                config.processedOrderIds.add(orderId);
                            }
                        } catch (err) {
                            log(`获取订单详情失败: ${err.message}`, true);
                        }
                    }
                }
                
                // 计算平均价格
                if (config.stats.totalFilledQuantity > 0) {
                    config.stats.averagePrice = config.stats.totalFilledAmount / config.stats.totalFilledQuantity;
                    log(`更新平均成交价: ${config.stats.averagePrice.toFixed(2)} USDC`);
                }
            }
            
            if (initialOpenOrders && initialOpenOrders.length > 0) {
                // 重置pendingOrderIds并添加所有当前订单
                config.pendingOrderIds = currentPendingOrderIds;
                log(`初始未成交订单数量: ${config.pendingOrderIds.size}`);
                
                // 记录详细信息到日志
                initialOpenOrders.forEach((order, index) => {
                    log(`初始未成交订单 #${index+1}: ID=${order.id}, 价格=${order.price}, 数量=${order.quantity}`);
                });
            } else {
                log('警告: 未找到任何未成交订单，可能所有订单已成交或创建失败');
                config.pendingOrderIds = new Set();
            }
        } catch (error) {
            log(`初始化未成交订单跟踪失败: ${error.message}`, true);
            // 确保pendingOrderIds被初始化，即使出错
            config.pendingOrderIds = new Set();
        }
        
        // 查询所有订单并更新统计信息，确保均价计算准确
        await queryOrdersAndUpdateStats(client, symbol);
        
        // 显示统计信息
        displayStats();
        
        // 检查是否所有计划的订单都已创建
        if (successCount < plannedOrderCount) {
            log(`\n注意: 只成功创建了 ${successCount}/${plannedOrderCount} 个订单，但仍将继续进入监控阶段`);
        } else {
            log(`已创建所有 ${plannedOrderCount} 个订单，准备进入监控阶段`);
        }
        
        // 开始监控止盈条件
        log(`\n开始监控止盈条件 (${takeProfitPercentage}%)...`);
        
        let monitoringAttempts = 0;
        let takeProfitTriggered = false;
        let lastOrderCheckTime = Date.now();
        let lastDisplayTime = Date.now();
        
        // 无订单成交自动重启相关变量
        const autoRestartNoFill = userConfig.actions.autoRestartNoFill === true;
        const noFillRestartMinutes = userConfig.advanced.noFillRestartMinutes || 60;
        const noFillRestartMs = noFillRestartMinutes * 60 * 1000;
        const initialStartTime = Date.now();
        let hadFilledOrders = config.stats.filledOrders > 0;
        
        if (autoRestartNoFill) {
            log(`启用无订单成交自动重启: 如果 ${noFillRestartMinutes} 分钟内没有订单成交，将自动重启脚本`);
        }
        
        // 首次显示账户信息
        displayAccountInfo();
        
        // 添加心跳计时器，确保脚本仍在运行
        const heartbeatInterval = setInterval(() => {
            const timeNow = new Date().toLocaleString();
            logToFile(`心跳检查: 脚本正在运行 ${timeNow}`);
        }, 60000); // 每分钟记录一次心跳
        
        while (!takeProfitTriggered) {
            try {
                monitoringAttempts++;
                
                // 记录每一轮监控的开始
                const cycleStartTime = Date.now();
                logToFile(`开始第 ${monitoringAttempts} 轮监控检查`);
                
                // 重置WebSocket日志控制，每个监控周期允许记录一次
                wsLogControl.loggedThisCycle = false;
                wsLogControl.cycleStartTime = cycleStartTime;
                
                // 每轮监控显示一次当前价格状态摘要（替代频繁的价格更新消息）
                if (config.currentPriceInfo && config.currentPriceInfo.price) {
                    const symbol = config.symbol;
                    const price = config.currentPriceInfo.price;
                    const source = config.currentPriceInfo.source || 'WebSocket';
                    const updateTime = config.currentPriceInfo.updateTime 
                        ? new Date(config.currentPriceInfo.updateTime).toLocaleTimeString() 
                        : '未知';
                    
                    // 添加价格上下文
                    let priceContext = '';
                    if (config.stats.averagePrice > 0) {
                        const priceIncrease = config.currentPriceInfo.increase;
                        const averagePrice = config.stats.averagePrice;
                        const diffAmount = price - averagePrice;
                        const takeProfitPercentage = userConfig.trading.takeProfitPercentage;
                        const progress = takeProfitPercentage > 0 ? (priceIncrease / takeProfitPercentage * 100).toFixed(1) : 0;
                        
                        priceContext = `均价: ${averagePrice.toFixed(2)}, 差价: ${diffAmount >= 0 ? '+' : ''}${diffAmount.toFixed(2)}, 涨幅: ${priceIncrease >= 0 ? '+' : ''}${priceIncrease.toFixed(2)}%, 完成: ${progress}%`;
                    }
                    
                    log(`[价格摘要] ${symbol}: ${price.toFixed(2)} USDC (来源: ${source}, 时间: ${updateTime}) ${priceContext}`);
                } else {
                    log(`[价格摘要] 暂无价格数据，等待WebSocket连接...`);
                }
                
                // 每10次检查显示一次监控状态（只记录到文件，不在控制台显示）
                if (monitoringAttempts % 10 === 0) {
                    logToFile(`持续监控中... (已运行 ${Math.floor(monitoringAttempts * userConfig.advanced.monitorIntervalSeconds / 60)} 分钟)`);
                    
                    // 不再重新加载配置
                    // 直接使用启动时的止盈百分比
                }
                
                // 每次循环更新一次控制台显示
                const currentTime = Date.now();
                if (currentTime - lastDisplayTime > (userConfig.advanced.monitorIntervalSeconds * 1000)) {
                    try {
                        // 显示账户信息 - 由WebSocket自动更新，这里只是确保即使WebSocket未连接也能更新
                        if (!wsConnected || !config.currentPriceInfo) {
                            // 只有在WebSocket未连接或无价格数据时才通过监控循环更新显示
                            displayAccountInfo();
                        }
                        lastDisplayTime = currentTime;
                    } catch (displayError) {
                        logToFile(`显示账户信息时出错: ${displayError.message}`, true);
                    }
                }
                
                // 每次检查前都更新统计数据，确保使用最新的均价
                let hasFilledOrders = false;
                try {
                    hasFilledOrders = await queryOrdersAndUpdateStats(client, symbol);
                    logToFile(`订单统计更新完成, 成交订单: ${hasFilledOrders ? '有' : '无'}`);
                } catch (statsError) {
                    logToFile(`更新订单统计时出错: ${statsError.message}`, true);
                }
                
                // 记录循环中间点，监控执行进度
                logToFile(`监控进度: 已完成订单统计更新, 循环已运行 ${((Date.now() - cycleStartTime)/1000).toFixed(1)} 秒`);
                
                // 如果之前没有成交订单，但现在有了，则记录这一状态变化
                if (!hadFilledOrders && hasFilledOrders) {
                    logToFile(`检测到首次订单成交，自动重启计时器已取消`);
                    hadFilledOrders = true;
                }
                
                // 检查是否需要因无订单成交而重启
                if (autoRestartNoFill && !hadFilledOrders) {
                    const runningTimeMs = Date.now() - initialStartTime;
                    const remainingMinutes = Math.ceil((noFillRestartMs - runningTimeMs) / 60000);
                    
                    if (runningTimeMs >= noFillRestartMs) {
                        log(`\n===== 无订单成交自动重启触发 =====`);
                        log(`已运行 ${Math.floor(runningTimeMs / 60000)} 分钟无任何订单成交`);
                        log(`根据配置，系统将重新开始交易...`);
                        
                        // 先取消所有未成交订单
                        log(`取消所有未成交订单...`);
                        await cancelAllOrders(client);
                        
                        clearInterval(heartbeatInterval); // 清除心跳检查
                        return true; // 返回true表示需要重启
                    } else if (monitoringAttempts % 30 === 0) {
                        // 每30次检查(约15分钟)提示一次还有多久会触发自动重启
                        logToFile(`无订单成交自动重启: 如果继续无订单成交，将在 ${remainingMinutes} 分钟后重启`);
                    }
                }
                
                // 每次定期检查订单状态
                const orderCheckIntervalMs = Math.max(1, userConfig.advanced.checkOrdersIntervalMinutes || 10) * 60 * 1000;
                const checkTimeNow = Date.now();
                
                // 定期检查未成交的订单状态
                if (checkTimeNow - lastOrderCheckTime > orderCheckIntervalMs) {
                    logToFile(`定期检查订单状态...`);
                    // 调用API获取所有未成交订单
                    try {
                        await queryOrdersAndUpdateStats(client, symbol);
                        lastOrderCheckTime = checkTimeNow;
                    } catch (checkError) {
                        logToFile(`定期检查订单状态时出错: ${checkError.message}`, true);
                    }
                }
                
                // 检查止盈条件
                // 只有当有成交的买单时才检查止盈
                if (config.stats.filledOrders > 0) {
                    try {
                        // 只使用WebSocket价格，完全禁用REST API备用
                        let currentPrice = null;
                        let priceSource = "WebSocket";
                        
                        // 增加调试日志
                        logToFile(`WebSocket连接状态: ${wsConnected ? '已连接' : '未连接'}`);
                        logToFile(`当前价格信息: ${JSON.stringify(config.currentPriceInfo)}`);
                        
                        // 强制使用WebSocket价格数据，如果没有则等待
                        if (config.currentPriceInfo && config.currentPriceInfo.price) {
                            currentPrice = config.currentPriceInfo.price;
                            priceSource = config.currentPriceInfo.source || "WebSocket";
                            
                            // 记录价格更新时间，但不使用它来决定是否使用备用API
                            if (config.currentPriceInfo.updateTime) {
                                const updateTime = new Date(config.currentPriceInfo.updateTime);
                                const currentTime = new Date();
                                const priceAge = currentTime - updateTime;
                                logToFile(`价格更新时间: ${updateTime.toISOString()}, 当前时间: ${currentTime.toISOString()}, 年龄: ${priceAge}ms`);
                            }
                        } else {
                            // 如果没有WebSocket价格，记录信息并跳过本次检查
                            log('等待WebSocket价格数据...');
                            // 不要从main函数返回，只跳过当前循环
                            continue; // 修改: 从return改为continue，只跳过当前循环
                        }
                        
                        // 计算当前涨幅
                        const averagePrice = config.stats.averagePrice;
                        if (averagePrice > 0 && currentPrice !== null) {
                            // 使用最新获取的价格重新计算涨幅，不依赖存储的值
                            const priceIncrease = (currentPrice - averagePrice) / averagePrice * 100;
                            
                            // 记录当前价格和涨幅到日志
                            logToFile(`检查止盈 - 当前价格: ${currentPrice} USDC (来源: ${priceSource}), 平均成本: ${averagePrice.toFixed(2)} USDC, 涨幅: ${priceIncrease.toFixed(2)}%`);
                            
                            // 更新显示
                            const currentTime = Date.now();
                            if (!config.lastDisplayUpdate || (currentTime - config.lastDisplayUpdate) > 15000) {
                                displayAccountInfo();
                                config.lastDisplayUpdate = currentTime;
                            }
                            
                            // 检查是否达到止盈目标
                            if (priceIncrease >= takeProfitPercentage) {
                                log(`\n===== 止盈条件达成！=====`);
                                log(`当前价格: ${currentPrice} USDC`);
                                log(`平均买入价: ${averagePrice.toFixed(2)} USDC`);
                                log(`涨幅: ${priceIncrease.toFixed(2)}% >= 止盈点: ${takeProfitPercentage}%`);
                                log('准备卖出获利...');
                                
                                // 先取消所有未成交的买单
                                await cancelAllOrders(client);
                                
                                // 执行卖出操作
                                const sellResult = await sellAllPosition(client, symbol, tradingCoin);
                                
                                if (sellResult) {
                                    log(`止盈卖出成功，订单ID: ${sellResult.id}`);
                                    
                                    // 先关闭WebSocket连接，避免连接问题
                                    log('关闭WebSocket连接，准备退出或重启...');
                                    closeWebSocket();
                                    
                                    // 是否需要重新启动新一轮交易？
                                    const restartAfterTakeProfit = userConfig.actions.restartAfterTakeProfit === true;
                                    
                                    if (restartAfterTakeProfit) {
                                        log(`根据配置，系统将重新开始新一轮交易...`);
                                        clearInterval(heartbeatInterval); // 清除心跳检查
                                        return true; // 返回true表示需要重启
                                    } else {
                                        log(`交易完成，程序将退出。`);
                                        clearInterval(heartbeatInterval); // 清除心跳检查
                                        return false; // 返回false表示不需要重启
                                    }
                                }
                                
                                takeProfitTriggered = true; // 设置标志位结束循环
                            }
                        } else {
                            // 没有实际成交的买入订单或价格数据，继续监控但不触发止盈
                            logToFile('当前没有实际成交的买入订单或有效价格数据，无法计算涨幅，继续监控...');
                        }
                    } catch (priceError) {
                        logToFile(`检查止盈条件时出错: ${priceError.message}`, true);
                    }
                }
                
                // 记录本轮监控完成
                const cycleDuration = (Date.now() - cycleStartTime)/1000;
                logToFile(`完成第 ${monitoringAttempts} 轮监控检查, 用时 ${cycleDuration.toFixed(1)} 秒`);
                
                // 根据配置的间隔时间检查，但最多等待60秒（防止长时间卡住）
                const waitTime = Math.min((userConfig.advanced.monitorIntervalSeconds || 30) * 1000, 60000);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            } catch (error) {
                log(`监控过程中发生错误: ${error.message}`, true);
                log(`错误堆栈: ${error.stack || '无堆栈信息'}`, true);
                // 出错后等待短一点的时间再继续，避免长时间卡住
                await new Promise(resolve => setTimeout(resolve, 30000));
            }
        }
        
        // 清除心跳检查
        clearInterval(heartbeatInterval);
        
        // 关闭WebSocket连接 (新增)
        closeWebSocket();
        
        if (takeProfitTriggered) {
            log('\n===== 止盈交易已完成 =====');
        }
        
        // 输出结果统计
        log('\n=== 订单创建结果 ===');
        log(`计划创建订单数: ${orders.length}`);
        log(`成功创建订单数: ${successCount}`);
        log('=== 交易周期完成 ===');
        
        // 检查是否需要重启
        if (userConfig.actions.restartAfterTakeProfit && takeProfitTriggered) {
            log('根据配置，系统将在10秒后重新开始交易...');
            await new Promise(resolve => setTimeout(resolve, 10000));
            return true; // 返回true表示需要重启
        }
        
        return false; // 默认不重启
        
    } catch (error) {
        log(`程序执行错误: ${error.message}`, true);
        
        // 关闭WebSocket连接 (新增)
        closeWebSocket();
        
        // 致命错误后等待较长时间再重试
        log('系统将在5分钟后尝试重启...');
        await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
        return true; // 出错后仍然重启
    }
}

// 运行程序并处理重启
async function runWithRestart() {
    let shouldRestart = true;
    
    while (shouldRestart) {
        try {
            shouldRestart = await main();
            
            if (shouldRestart) {
                log('系统准备重新启动...');
                // 关闭当前WebSocket连接 (新增)
                closeWebSocket();
                
                // 重置全局配置的一些状态
                config.scriptStartTime = new Date();
                config.processedOrderIds = new Set();
                config.pendingOrderIds = new Set();
                
                // 重要: 清空之前所有创建的订单记录，防止统计错误
                config.allCreatedOrderIds = new Set();
                config.createdOrders = {};
                config.createdOrderSignatures = new Set();
                
                config.stats = {
                    totalOrders: 0,
                    filledOrders: 0,
                    totalFilledAmount: 0,
                    totalFilledQuantity: 0,
                    averagePrice: 0,
                    lastUpdateTime: null
                };
                config.currentPriceInfo = null;
                
                // 重置WebSocket状态变量
                wsConnected = false;
                wsReconnectAttempts = 0;
                wsReconnecting = false;
                
                // 记录重启信息到日志
                log('已完全重置所有订单记录和统计数据');
                
                // 等待5秒再重启，确保WebSocket状态完全重置
                log('等待5秒后重新启动系统...');
                await new Promise(resolve => setTimeout(resolve, 5000));
            } else {
                log('系统将正常退出，不再重启');
                // 关闭当前WebSocket连接 (新增)
                closeWebSocket();
            }
        } catch (error) {
            log(`主程序运行异常: ${error.message}`, true);
            // 关闭当前WebSocket连接 (新增)
            closeWebSocket();
            
            log('系统将在1分钟后尝试重启...');
            await new Promise(resolve => setTimeout(resolve, 60 * 1000));
            // 出现异常仍然尝试重启
            shouldRestart = true;
        }
    }
    
    if (rl && !rl.closed) {
        rl.close();
    }
}

// 运行程序
runWithRestart().catch(error => {
    log(`程序启动错误: ${error.message}`, true);
    // 关闭当前WebSocket连接 (新增)
    closeWebSocket();
    
    if (rl && !rl.closed) {
        rl.close();
    }
    process.exit(1);
});
