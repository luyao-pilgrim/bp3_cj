const WebSocket = require('ws');
const { defaultLogger } = require('../utils/logger');

/**
 * WebSocket管理器类 - 负责处理与交易所的WebSocket连接
 */
class WebSocketManager {
  /**
   * 构造函数
   * @param {Object} options - 配置选项
   * @param {Object} options.config - 配置对象
   * @param {Object} options.logger - 日志记录器
   * @param {Function} options.onMessage - 消息处理回调
   * @param {Function} options.onPrice - 价格更新回调
   */
  constructor(options = {}) {
    // 优先使用配置中的WebSocket URL，然后是选项中的URL，最后使用默认值
    this.wsUrl = options.config?.websocket?.url || options.wsUrl || 'wss://ws.backpack.exchange';
    this.config = options.config || {};
    this.ws = null;
    this.connectionActive = false;
    this.heartbeatInterval = null;
    this.reconnectTimeout = null;
    this.logger = options.logger || console;
    this.onMessage = options.onMessage || (() => {});
    
    // 修复onPriceUpdate回调 - 确保正确设置
    this.onPriceUpdate = options.onPriceUpdate || (() => {});
    
    // 验证和记录回调函数设置情况
    if (typeof this.onPriceUpdate === 'function') {
      this.logger.log('WebSocketManager: onPriceUpdate回调已设置');
    } else {
      this.logger.log('警告: WebSocketManager.onPriceUpdate未正确设置');
    }
    
    // 价格更新控制
    this.lastLoggedPrice = null;
    this.lastLogTime = 0;
    this.logThrottleMs = 1000; // 每秒最多记录一次价格
    this.logPriceChange = 0.01; // 记录百分比变化超过1%的价格
    
    // 记录控制
    this.shouldLog = true;
    this.logHeartbeats = false;
  }
  
  /**
   * 重置日志控制参数
   */
  resetLogControl() {
    this.lastLoggedPrice = null;
    this.lastLogTime = 0;
  }
  
  /**
   * 设置价格WebSocket连接
   * @param {string} symbol - 交易对符号
   */
  setupPriceWebSocket(symbol) {
    // 关闭现有连接
    if (this.ws) {
      this.closeWebSocket();
    }

    this.logger.log(`开始建立WebSocket连接: ${this.wsUrl}`);
    
    try {
      // 创建WebSocket连接
      this.ws = new WebSocket(this.wsUrl);
      
      // 连接打开时的处理
      this.ws.on('open', () => {
        this.connectionActive = true;
        this.logger.log('WebSocket连接已建立');
        
        // 订阅行情频道
        this.subscribeTicker(symbol);
        
        // 设置心跳
        this.setupHeartbeat();
      });
      
      // 接收消息时的处理
      this.ws.on('message', (data) => {
        try {
          const now = new Date();
          let message = {};
          
          try {
            message = JSON.parse(data.toString());
            // 记录接收到的消息类型到日志文件
            if (Math.random() < 0.2) {  // 增加采样率到20%以便更好地调试
              this.logger.logToFile(`收到WS消息类型: ${JSON.stringify(Object.keys(message))}`);
              this.logger.logToFile(`消息内容: ${data.toString().substring(0, 150)}...`);
            }
          } catch (parseError) {
            this.logger.log(`解析WebSocket消息失败: ${parseError.message}`);
            return;
          }
          
          // 调用消息回调
          if (typeof this.onMessage === 'function') {
            this.onMessage(message);
          }
          
          // 处理PONG响应
          if (message.result === 'PONG') {
            this.logger.logToFile('收到PONG心跳响应');
            return;
          }
          
          // 处理订阅成功响应
          if (message.result === null && message.id) {
            this.logger.log(`订阅确认: ID=${message.id}`);
            return;
          }
          
          // 处理价格数据 - 尝试多种可能的格式
          if (
            (message.channel === 'ticker' && message.data) ||
            (message.e === 'ticker') ||
            (message.type === 'ticker') ||
            (message.stream && message.stream.includes('ticker') && message.data) ||
            (message.s && message.c) ||  // Binance格式
            (message.symbol && message.price) ||  // 通用格式
            (message.data && message.data.s && message.data.c)  // 嵌套格式
          ) {
            this.logger.log(`找到价格数据消息: ${JSON.stringify(message).substring(0, 100)}...`);
            this.processPriceData(message, symbol, now);
          } else {
            // 记录未识别的消息类型
            if (Math.random() < 0.1) {
              this.logger.logToFile(`未识别的消息格式: ${JSON.stringify(message).substring(0, 100)}...`);
            }
          }
        } catch (error) {
          this.logger.log(`处理WebSocket消息错误: ${error.message}`);
        }
      });
      
      // 连接关闭时的处理
      this.ws.on('close', () => {
        this.connectionActive = false;
        this.logger.log('WebSocket连接已关闭');
        
        // 清理心跳
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }
        
        // 尝试重连
        if (!this.reconnectTimeout) {
          this.reconnectTimeout = setTimeout(() => {
            this.logger.log('尝试重新连接WebSocket...');
            this.reconnectTimeout = null;
            this.setupPriceWebSocket(symbol);
          }, 5000);
        }
      });
      
      // 错误处理
      this.ws.on('error', (error) => {
        this.logger.log(`WebSocket错误: ${error.message}`);
      });
    } catch (error) {
      this.logger.log(`建立WebSocket连接失败: ${error.message}`);
    }
  }
  
  /**
   * 处理价格数据
   * @param {Object} data - 价格数据
   * @param {string} symbol - 交易对符号
   * @param {Date} now - 当前时间
   */
  processPriceData(data, symbol, now) {
    try {
      // 记录原始数据以便调试
      this.logger.logToFile(`处理价格数据: ${JSON.stringify(data).substring(0, 200)}...`);
      
      let tickerSymbol;
      let lastPrice;
      
      // 处理不同格式的数据
      if (data && data.data && data.data.s && data.data.c) {
        // Backpack 格式
        this.logger.log('识别为Backpack嵌套格式数据');
        tickerSymbol = data.data.s;
        lastPrice = parseFloat(data.data.c);
      } else if (data && data.s && data.c) {
        // Binance 格式
        this.logger.log('识别为Binance格式数据');
        tickerSymbol = data.s;
        lastPrice = parseFloat(data.c);
      } else if (data && data.symbol && data.price) {
        // 标准格式
        this.logger.log('识别为标准格式数据');
        tickerSymbol = data.symbol;
        lastPrice = parseFloat(data.price);
      } else if (data && data.data && typeof data.data === 'object') {
        // 尝试从data字段中提取
        const nestedData = data.data;
        if (nestedData.s && nestedData.c) {
          this.logger.log('从嵌套data对象提取价格数据');
          tickerSymbol = nestedData.s;
          lastPrice = parseFloat(nestedData.c);
        } else if (nestedData.symbol && nestedData.price) {
          this.logger.log('从嵌套data对象提取标准格式价格数据');
          tickerSymbol = nestedData.symbol;
          lastPrice = parseFloat(nestedData.price);
        }
      } else if (data && data.result && data.result.data) {
        // Backpack可能的另一种格式
        const resultData = data.result.data;
        if (Array.isArray(resultData) && resultData.length > 0) {
          const firstItem = resultData[0];
          if (firstItem.s && firstItem.c) {
            this.logger.log('从result.data数组提取价格数据');
            tickerSymbol = firstItem.s;
            lastPrice = parseFloat(firstItem.c);
          }
        }
      } else {
        // 未知格式 - 记录详细信息以便调试
        this.logger.log(`未识别的数据格式: ${JSON.stringify(data).substring(0, 100)}...`);
        return;
      }
      
      // 处理提取到的价格和符号
      if (tickerSymbol && !isNaN(lastPrice) && lastPrice > 0) {
        this.logger.log(`成功提取价格数据: 交易对=${tickerSymbol}, 价格=${lastPrice}`);
        
        // 标准化符号格式
        const normalizedSymbol = symbol.replace('-', '_').toUpperCase();
        const normalizedTickerSymbol = tickerSymbol.replace('-', '_').toUpperCase();
        
        // 确认交易对匹配
        if (normalizedTickerSymbol.includes(normalizedSymbol) || normalizedSymbol.includes(normalizedTickerSymbol)) {
          this.handlePriceUpdate(tickerSymbol, lastPrice, symbol, now);
        } else {
          this.logger.log(`交易对不匹配: 收到=${normalizedTickerSymbol}, 订阅=${normalizedSymbol}`);
        }
      } else {
        this.logger.log(`提取的价格数据无效: 交易对=${tickerSymbol}, 价格=${lastPrice}`);
      }
    } catch (error) {
      this.logger.log(`处理价格数据出错: ${error.message}, 原始数据: ${JSON.stringify(data).substring(0, 100)}...`);
    }
  }
  
  /**
   * 订阅行情频道
   * @param {string} symbol - 交易对符号
   */
  subscribeTicker(symbol) {
    if (!this.connectionActive || !this.ws) {
      this.logger.log('WebSocket未连接，无法订阅行情');
      return false;
    }
    
    try {
      // 确保使用正确的格式
      const formattedSymbol = symbol.toUpperCase();
      
      // 使用多种订阅格式提高成功率
      const subscriptions = [
        // 标准格式
        {
          method: "SUBSCRIBE",
          params: [`ticker.${formattedSymbol}`],
          id: Date.now()
        },
        // 备用格式
        {
          method: "SUBSCRIBE",
          params: [`ticker@${formattedSymbol.replace('_', '')}`],
          id: Date.now() + 1
        },
        // 再一种备用格式
        {
          op: "subscribe",
          channel: "ticker",
          market: formattedSymbol,
          id: Date.now() + 2
        }
      ];
      
      // 发送所有订阅格式
      for (const sub of subscriptions) {
        this.logger.log(`发送订阅请求: ${JSON.stringify(sub)}`);
        this.ws.send(JSON.stringify(sub));
      }
      
      // 请求立即获取一次价格
      const getTickerMsg = {
        method: "GET_TICKER",
        params: {
          symbol: formattedSymbol
        },
        id: Date.now() + 3
      };
      this.logger.log(`请求当前价格: ${JSON.stringify(getTickerMsg)}`);
      this.ws.send(JSON.stringify(getTickerMsg));
      
      this.logger.log(`已订阅行情: ${formattedSymbol}`);
      
      return true;
    } catch (error) {
      this.logger.log(`订阅行情失败: ${error.message}`);
      return false;
    }
  }
  
  /**
   * 设置心跳
   */
  setupHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.connectionActive) {
        try {
          // 发送心跳消息
          const pingMsg = JSON.stringify({ "op": "ping" });
          this.ws.send(pingMsg);
          
          // 心跳信息只记录到日志文件，不在终端显示
          if (this.logHeartbeats && Math.random() < 0.1) {
            this.logger.logToFile('已发送心跳');
          }
        } catch (error) {
          // 心跳失败是重要错误，保留在终端输出
          this.logger.log(`发送心跳失败: ${error.message}`);
        }
      }
    }, 30000); // 每30秒发送一次心跳
  }
  
  /**
   * 关闭WebSocket连接
   */
  closeWebSocket() {
    // 清理心跳
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // 清理重连定时器
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    // 关闭连接
    if (this.ws) {
      try {
        this.ws.terminate();
        this.ws = null;
        this.connectionActive = false;
        this.logger.log('WebSocket连接已关闭');
      } catch (error) {
        this.logger.log(`关闭WebSocket连接失败: ${error.message}`);
      }
    }
  }
  
  /**
   * 获取连接状态
   * @returns {boolean} 是否已连接
   */
  isConnected() {
    return this.connectionActive;
  }
  
  /**
   * 处理价格更新
   * @param {string} tickerSymbol - 交易对符号
   * @param {number} lastPrice - 最新价格
   * @param {string} symbol - 订阅的原始交易对符号
   * @param {Date} now - 当前时间
   */
  handlePriceUpdate(tickerSymbol, lastPrice, symbol, now) {
    try {
      // 避免处理无效数据
      if (!tickerSymbol || !lastPrice || isNaN(lastPrice) || lastPrice <= 0) {
        return;
      }
      
      // 记录价格更新（如果价格变化显著才在终端显示）
      const timeStr = now.toLocaleTimeString();
      
      // 显著价格变化或首次接收价格数据时在终端显示
      const hasSignificantChange = this.previousPrice && 
        Math.abs(lastPrice - this.previousPrice) / this.previousPrice > 0.001;
      
      if (hasSignificantChange || !this.previousPrice) {
        // 只在首次接收或有明显变化时在终端显示
        if (!this.previousPrice) {
          this.logger.log(`首次接收价格数据: ${lastPrice} USDC`);
        } else if (hasSignificantChange) {
          const changePercent = ((lastPrice - this.previousPrice) / this.previousPrice) * 100;
          if (Math.abs(changePercent) > 0.05) {
            this.logger.log(`价格变动: ${lastPrice} USDC (${changePercent > 0 ? '+' : ''}${changePercent.toFixed(2)}%)`);
          }
        }
      } else {
        // 小变化只记录到日志文件
        this.logger.logToFile(`${timeStr} - ${tickerSymbol}: ${lastPrice}`);
      }
      
      // 更新最后成功接收的价格数据
      this.lastPriceData = {
        symbol: tickerSymbol,
        price: lastPrice,
        time: now
      };
      
      this.previousPrice = lastPrice;
      
      // 通知外部回调 - 重要：确保回调函数的存在性和参数正确
      this.logger.log(`准备调用外部价格回调: symbol=${tickerSymbol}, price=${lastPrice}`);
      if (typeof this.onPriceUpdate === 'function') {
        try {
          this.onPriceUpdate(tickerSymbol, lastPrice, now);
          this.logger.log(`外部价格回调调用成功`);
        } catch (callbackError) {
          this.logger.log(`调用价格回调函数失败: ${callbackError.message}`);
        }
      } else {
        this.logger.log(`警告: onPriceUpdate回调未设置或不是函数`);
      }
      
      // 重置失败计数
      this.failureCount = 0;
    } catch (error) {
      this.logger.log(`处理价格更新失败: ${error.message}`);
    }
  }
}

module.exports = WebSocketManager; 