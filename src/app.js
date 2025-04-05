const BackpackService = require('./services/backpackService');
const PriceMonitor = require('./core/priceMonitor');
const TradingStrategy = require('./core/tradingStrategy');
const OrderManagerService = require('./core/orderManager');
const { Order, OrderManager } = require('./models/Order');
const TradeStats = require('./models/TradeStats');
const { log, defaultLogger } = require('./utils/logger');
const TimeUtils = require('./utils/timeUtils');
const Formatter = require('./utils/formatter');

/**
 * 应用程序类 - 协调各个组件工作
 */
class TradingApp {
  /**
   * 构造函数
   * @param {Object} config - 配置对象
   */
  constructor(config) {
    this.config = config;
    this.logger = defaultLogger;
    
    // 初始化组件
    this.backpackService = new BackpackService(config, this.logger);
    this.tradingStrategy = new TradingStrategy(this.logger, this.config);
    this.orderManager = new OrderManager();
    this.tradeStats = new TradeStats();
    
    // 初始化订单管理服务
    this.orderManagerService = new OrderManagerService(config, this.backpackService);
    
    // 初始化价格监控器
    this.priceMonitor = new PriceMonitor({
      config: config,
      onPriceUpdate: this.handlePriceUpdate.bind(this),
      logger: this.logger
    });
    
    // 应用状态
    this.running = false;
    this.symbol = null;
    this.tradingCoin = null;
    this.currentPriceInfo = null;
    this.monitoringInterval = null;
    this.scriptStartTime = new Date();
    this.cycleLogFile = null;
    this.lastDisplayTime = 0;
    this.displayInitialized = false;
    this.takeProfitTriggered = false;
    this.needRestart = false; // 标记是否需要重启
  }
  
  /**
   * 处理价格更新
   * @param {Object} priceInfo - 价格信息
   */
  handlePriceUpdate(priceInfo) {
    // 确保从WebSocket接收到的价格能够被更新到应用状态
    this.currentPriceInfo = priceInfo;
    
    // 计算价格涨幅
    if (priceInfo && this.tradeStats.averagePrice > 0) {
      const priceIncrease = ((priceInfo.price - this.tradeStats.averagePrice) / this.tradeStats.averagePrice) * 100;
      this.currentPriceInfo.increase = priceIncrease;
      
      // 如果价格变化大，记录到终端
      if (Math.abs(priceIncrease) > 0.1) {
        const direction = priceIncrease >= 0 ? '上涨' : '下跌';
        log(`相对均价${direction}: ${Math.abs(priceIncrease).toFixed(2)}% (当前: ${priceInfo.price.toFixed(2)}, 均价: ${this.tradeStats.averagePrice.toFixed(2)})`);
      }
      
      // 检查是否达到止盈条件 - 只有当有成交的买单时才检查止盈
      if (this.tradeStats.filledOrders > 0 && this.running && !this.takeProfitTriggered) {
        const takeProfitPercentage = this.config.trading.takeProfitPercentage;
        
        // 检查是否达到止盈条件
        const takeProfitReached = this.tradingStrategy.isTakeProfitTriggered(
          priceInfo.price, 
          this.tradeStats.averagePrice, 
          takeProfitPercentage
        );
        
        if (takeProfitReached) {
          log(`\n===== 止盈条件达成！=====`);
          log(`当前价格: ${priceInfo.price} USDC`);
          log(`平均买入价: ${this.tradeStats.averagePrice.toFixed(2)} USDC`);
          log(`涨幅: ${priceIncrease.toFixed(2)}% >= 止盈点: ${takeProfitPercentage}%`);
          log('准备卖出获利...');
          
          // 设置止盈触发标志，避免重复触发
          this.takeProfitTriggered = true;
          
          // 执行止盈操作
          this.executeTakeProfit();
        }
      }
    }
    
    // 更新显示（限制频率）
    const now = Date.now();
    if (!this.lastDisplayTime || (now - this.lastDisplayTime) > 15000) {
      this.displayAccountInfo();
      this.lastDisplayTime = now;
    }
  }
  
  /**
   * 执行止盈操作
   */
  async executeTakeProfit() {
    try {
      // 先取消所有未成交的买单
      await this.cancelAllOrders();
      
      // 执行卖出操作
      await this.sellAllPosition();
      
      // 清除监控间隔
      if (this.monitoringInterval) {
        clearInterval(this.monitoringInterval);
        this.monitoringInterval = null;
      }
      
      // 检查是否需要在止盈后自动重启
      if (this.config.actions.restartAfterTakeProfit) {
        log('\n===== 止盈后自动重启交易 =====');
        // 设置需要重启标志
        this.needRestart = true;
      }
    } catch (error) {
      log(`执行止盈操作时出错: ${error.message}`, true);
    }
  }
  
  /**
   * 初始化交易环境
   */
  async initialize() {
    try {
      log('正在初始化交易环境...');
      
      // 读取并设置配置
      this.config = this.config || {};
      this.tradingCoin = this.config.trading?.tradingCoin || this.config.tradingCoin || 'BTC';
      this.symbol = `${this.tradingCoin}_USDC`;
      this.apiSymbol = this.symbol;  // 使用相同的格式，不需要转换
      
      log(`交易对: ${this.apiSymbol}`);
      
      // 初始化服务和管理器
      // TimeUtils是静态类，不需要实例化
      this.orderManager = new OrderManager(this.logger);
      
      // 确保传递logger给所有服务
      this.backpackService = new BackpackService(this.config, this.logger);
      this.priceMonitor = new PriceMonitor({
        config: this.config,
        onPriceUpdate: this.handlePriceUpdate.bind(this),
        logger: this.logger
      });
      this.tradingStrategy = new TradingStrategy(this.logger, this.config);
      
      log('所有服务初始化完成');
      
      // 记录应用启动时间
      this.startTime = new Date();
      log(`程序启动时间: ${this.startTime.toLocaleString()}`);
      
      // 初始化状态变量
      this.running = false;
      this.needRestart = false;
      this.lastTradeTime = new Date();
      this.lastStatusLogTime = new Date();
      
      // 设置价格监控回调
      this.priceMonitor.onPriceUpdate = (priceInfo) => this.handlePriceUpdate(priceInfo);
      
      // 尝试获取初始价格
      try {
        const ticker = await this.backpackService.getTicker(this.apiSymbol);
        if (ticker && ticker.lastPrice) {
          log(`初始价格: ${ticker.lastPrice} USDC (来源: API)`);
          this.currentPrice = parseFloat(ticker.lastPrice);
        } else {
          log('警告: 无法获取初始价格');
        }
      } catch (error) {
        log(`获取初始价格失败: ${error.message}`);
      }
      
      return true;
    } catch (error) {
      log(`初始化失败: ${error.message}`);
      return false;
    }
  }
  
  /**
   * 启动交易应用
   */
  async start() {
    try {
      if (this.running) {
        log('应用程序已经在运行中');
        return false;
      }
      
      // 初始化环境
      const initialized = await this.initialize();
      if (!initialized) {
        log('初始化失败，应用程序无法启动', true);
        return false;
      }
      
      // 启动价格监控
      this.priceMonitor.startMonitoring(this.symbol);
      
      // 添加轮询检查机制，每5秒检查一次价格数据，避免WebSocket回调失败的情况
      this.priceCheckInterval = setInterval(() => {
        try {
          // 直接从priceMonitor获取价格数据
          if (this.priceMonitor.currentPrice > 0) {
            const priceInfo = {
              price: this.priceMonitor.currentPrice,
              symbol: this.symbol,
              source: 'WebSocket轮询',
              updateTime: this.priceMonitor.lastUpdateTime || Date.now()
            };
            
            log(`轮询获取价格: ${priceInfo.price} USDC`);
            
            // 更新当前价格信息
            this.currentPriceInfo = priceInfo;
            
            // 计算涨跌幅
            if (this.tradeStats.averagePrice > 0) {
              const priceIncrease = ((priceInfo.price - this.tradeStats.averagePrice) / this.tradeStats.averagePrice) * 100;
              this.currentPriceInfo.increase = priceIncrease;
            }
            
            // 更新显示
            this.displayAccountInfo();
          }
          // 如果priceMonitor没有价格数据，但WebSocketManager有
          else if (this.priceMonitor.wsManager && 
                  this.priceMonitor.wsManager.lastPriceData && 
                  this.priceMonitor.wsManager.lastPriceData.price > 0) {
            
            const wsData = this.priceMonitor.wsManager.lastPriceData;
            const priceInfo = {
              price: wsData.price,
              symbol: wsData.symbol || this.symbol,
              source: 'WebSocketManager轮询',
              updateTime: wsData.time || Date.now()
            };
            
            log(`轮询从WebSocketManager获取价格: ${priceInfo.price} USDC`);
            
            // 更新当前价格信息
            this.currentPriceInfo = priceInfo;
            
            // 计算涨跌幅
            if (this.tradeStats.averagePrice > 0) {
              const priceIncrease = ((priceInfo.price - this.tradeStats.averagePrice) / this.tradeStats.averagePrice) * 100;
              this.currentPriceInfo.increase = priceIncrease;
            }
            
            // 更新显示
            this.displayAccountInfo();
          }
        } catch (error) {
          log(`价格轮询错误: ${error.message}`, true);
        }
      }, 5000);
      
      this.running = true;
      
      // 返回成功
      return true;
    } catch (error) {
      log(`启动应用程序失败: ${error.message}`, true);
      this.stop();
      return false;
    }
  }
  
  /**
   * 停止交易应用
   */
  stop() {
    if (!this.running) return;
    
    log('正在停止应用程序...');
    
    // 停止价格监控
    this.priceMonitor.stopMonitoring();
    
    // 清除监控间隔
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    
    // 清除价格检查间隔
    if (this.priceCheckInterval) {
      clearInterval(this.priceCheckInterval);
      this.priceCheckInterval = null;
    }
    
    this.running = false;
    log('应用程序已停止');
  }
  
  /**
   * 撤销所有未成交订单
   */
  async cancelAllOrders() {
    if (!this.running) {
      log('应用程序未运行，无法撤销订单');
      return false;
    }
    
    try {
      log(`开始撤销 ${this.symbol} 交易对的所有未完成订单...`);
      const result = await this.backpackService.cancelAllOrders(this.symbol);
      log(`撤销订单结果: ${JSON.stringify(result)}`);
      return true;
    } catch (error) {
      log(`撤销订单失败: ${error.message}`, true);
      return false;
    }
  }
  
  /**
   * 执行交易操作
   */
  async executeTrade() {
    try {
      log('开始执行交易策略...');
      
      // 检查当前价格
      if (!this.currentPrice || this.currentPrice <= 0) {
        log('警告: 当前价格无效，无法执行交易');
        return false;
      }
      
      log(`当前价格: ${this.currentPrice} USDC`);
      
      // 取消所有现有订单
      try {
        await this.backpackService.cancelAllOrders(this.apiSymbol);
        log('已取消所有现有订单');
      } catch (error) {
        log(`取消所有订单失败: ${error.message}`);
      }
      
      // 从配置中获取交易参数
      const maxDropPercentage = this.config.trading.maxDropPercentage;
      const totalAmount = this.config.trading.totalAmount;
      const orderCount = this.config.trading.orderCount;
      const incrementPercentage = this.config.trading.incrementPercentage;
      const minOrderAmount = this.config.advanced?.minOrderAmount || 10;
      
      // 确保所有交易参数都有效
      if (!maxDropPercentage || !totalAmount || !orderCount || !incrementPercentage) {
        log('警告: 交易参数无效，请检查配置文件', true);
        return false;
      }
      
      // 计算阶梯订单
      const orders = this.tradingStrategy.calculateIncrementalOrders(
        this.currentPrice,
        maxDropPercentage,
        totalAmount,
        orderCount,
        incrementPercentage,
        minOrderAmount,
        this.tradingCoin,
        this.apiSymbol
      );
      
      if (!orders || orders.length === 0) {
        log('警告: 没有生成有效的订单');
        return false;
      }
      
      log(`已生成 ${orders.length} 个阶梯买单`);
      
      // 创建订单
      let successCount = 0;
      for (const order of orders) {
        try {
          // 检查是否已存在相同的订单
          const orderSignature = `${order.symbol}_${order.price}_${order.quantity}`;
          if (this.orderManager.hasOrderSignature(orderSignature)) {
            log(`跳过重复订单: ${orderSignature}`);
            continue;
          }
          
          // 创建订单
          const result = await this.backpackService.createOrder({
            symbol: this.apiSymbol,
            side: 'Bid',
            orderType: 'Limit',
            price: order.price.toFixed(2),
            quantity: order.quantity.toFixed(6)
          });
          
          if (result && result.id) {
            // 添加到订单管理器
            const newOrder = new Order({
              id: result.id,
              symbol: order.symbol,
              side: 'Bid',
              price: order.price,
              quantity: order.quantity,
              status: result.status || 'New'
            });
            
            // 添加订单到管理器，并记录这个签名
            this.orderManager.addOrder(newOrder);
            this.orderManager.createdOrderSignatures.add(orderSignature);
            
            // 增加总订单计数
            this.tradeStats.totalOrders++;
            
            // 在终端显示订单创建信息（确保显示）
            log(`订单已创建: ${result.id} - ${order.quantity} ${this.tradingCoin} @ ${order.price} USDC`);
            successCount++;
          } else {
            log(`订单创建失败: ${JSON.stringify(order)}`);
          }
        } catch (error) {
          log(`创建订单失败: ${error.message}, 订单: ${JSON.stringify(order)}`);
        }
      }
      
      log(`成功创建 ${successCount}/${orders.length} 个订单`);
      
      // 更新最后交易时间
      this.lastTradeTime = new Date();
      
      // 启动止盈监控
      this.startTakeProfitMonitoring();
      
      return successCount > 0;
    } catch (error) {
      log(`执行交易操作失败: ${error.message}`);
      if (error.stack) {
        log(`错误堆栈: ${error.stack}`);
      }
      return false;
    }
  }
  
  /**
   * 查询订单并更新统计
   */
  async queryOrdersAndUpdateStats() {
    try {
      log('查询当前交易周期新成交的订单...');
      
      // 获取当前未成交订单
      const openOrders = await this.backpackService.getOpenOrders(this.symbol);
      const currentOpenOrderIds = new Set(openOrders.map(order => order.id));
      
      // 遍历所有创建的订单，检查哪些已经不在未成交列表中
      const filledOrders = [];
      for (const orderId of this.orderManager.getAllCreatedOrderIds()) {
        if (!currentOpenOrderIds.has(orderId)) {
          const order = this.orderManager.getOrder(orderId);
          
          // 如果订单存在且未处理，则视为已成交
          if (order && !this.tradeStats.isOrderProcessed(orderId)) {
            // 将订单标记为已成交
            order.status = 'Filled';
            
            // 确保设置正确的成交数量和金额
            // 如果订单已成交，应该将全部数量和金额标记为已成交
            if (order.filledQuantity <= 0) {
              order.filledQuantity = order.quantity;
            }
            
            if (order.filledAmount <= 0) {
              order.filledAmount = order.price * order.quantity;
            }
            
            // 添加到已成交订单列表
            filledOrders.push(order);
            
            // 记录订单成交信息
            log(`订单已成交: ${orderId} - ${order.quantity} ${this.tradingCoin} @ ${order.price} USDC`);
          }
        }
      }
      
      // 更新统计信息
      for (const order of filledOrders) {
        const result = this.tradeStats.updateStats(order);
        if (result) {
          // 如果统计更新成功，记录成交信息
          log(`更新交易统计: 成交订单数=${this.tradeStats.filledOrders}, 均价=${this.tradeStats.averagePrice.toFixed(2)} USDC`);
        }
      }
      
      // 更新订单管理器中的待处理订单ID列表
      this.orderManager.updatePendingOrderIds(Array.from(currentOpenOrderIds));
      
      return filledOrders.length > 0;
    } catch (error) {
      log(`查询订单历史并更新统计失败: ${error.message}`, true);
      return false;
    }
  }
  
  /**
   * 开始监控止盈条件
   */
  async startTakeProfitMonitoring() {
    if (!this.running) {
      log('应用程序未运行，无法开始监控止盈条件');
      return false;
    }
    
    // 获取止盈百分比
    const takeProfitPercentage = this.config.trading.takeProfitPercentage;
    log(`\n开始监控止盈条件 (${takeProfitPercentage}%)...`);
    
    // 首次显示账户信息
    this.displayAccountInfo();
    
    // 启动监控间隔
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    // 监控变量
    let monitoringAttempts = 0;
    this.takeProfitTriggered = false;
    let lastOrderCheckTime = Date.now();
    
    // 无订单成交自动重启相关变量
    const autoRestartNoFill = this.config.actions.autoRestartNoFill === true;
    const noFillRestartMinutes = this.config.advanced.noFillRestartMinutes || 60;
    const noFillRestartMs = noFillRestartMinutes * 60 * 1000;
    const initialStartTime = Date.now();
    let hadFilledOrders = this.tradeStats.filledOrders > 0;
    
    if (autoRestartNoFill) {
      log(`启用无订单成交自动重启: 如果 ${noFillRestartMinutes} 分钟内没有订单成交，将自动重启脚本`);
    }
    
    // 添加心跳计时器
    const heartbeatInterval = setInterval(() => {
      const timeNow = new Date().toLocaleString();
      this.logger.logToFile(`心跳检查: 脚本正在运行 ${timeNow}`);
    }, 60000);
    
    this.monitoringInterval = setInterval(async () => {
      try {
        monitoringAttempts++;
        
        // 记录每一轮监控的开始
        const cycleStartTime = Date.now();
        this.logger.logToFile(`开始第 ${monitoringAttempts} 轮订单监控检查`);
        
        // 更新显示
        this.displayAccountInfo();
        
        // 每次检查前都更新统计数据，确保使用最新的订单状态
        let hasFilledOrders = false;
        try {
          hasFilledOrders = await this.queryOrdersAndUpdateStats();
        } catch (statsError) {
          this.logger.logToFile(`更新订单统计时出错: ${statsError.message}`, true);
        }
        
        // 如果之前没有成交订单，但现在有了，则记录这一状态变化
        if (!hadFilledOrders && hasFilledOrders) {
          this.logger.logToFile(`检测到首次订单成交，自动重启计时器已取消`);
          hadFilledOrders = true;
        }
        
        // 检查是否需要因无订单成交而重启
        if (autoRestartNoFill && !hadFilledOrders) {
          const runningTimeMs = Date.now() - initialStartTime;
          
          if (runningTimeMs >= noFillRestartMs) {
            log(`\n===== 无订单成交自动重启触发 =====`);
            log(`已运行 ${Math.floor(runningTimeMs / 60000)} 分钟无任何订单成交`);
            log(`根据配置，系统将重新开始交易...`);
            
            // 先取消所有未成交订单
            await this.cancelAllOrders();
            
            clearInterval(heartbeatInterval);
            clearInterval(this.monitoringInterval);
            
            // 重置应用状态
            this.resetAppState();
            
            // 设置需要重启标志
            this.needRestart = true;
            
            return true;
          }
        }
        
        // 定期检查未成交的订单状态
        const orderCheckIntervalMs = Math.max(1, this.config.advanced.checkOrdersIntervalMinutes || 10) * 60 * 1000;
        const checkTimeNow = Date.now();
        
        if (checkTimeNow - lastOrderCheckTime > orderCheckIntervalMs) {
          await this.queryOrdersAndUpdateStats();
          lastOrderCheckTime = checkTimeNow;
        }
        
        // 注：价格和止盈检查已经在handlePriceUpdate方法中处理
        
      } catch (error) {
        log(`监控过程中发生错误: ${error.message}`, true);
        // 出错后等待短一点的时间再继续，避免长时间卡住
      }
    }, this.config.advanced.monitorIntervalSeconds * 1000);
  }
  
  /**
   * 卖出所有持仓
   */
  async sellAllPosition() {
    try {
      // 获取当前持仓情况
      const position = await this.backpackService.getPosition(this.symbol);
      if (!position || parseFloat(position.quantity) <= 0) {
        log('没有可卖出的持仓');
        return null;
      }
      
      // 获取当前市场价格
      const ticker = await this.backpackService.getTicker(this.symbol);
      const currentPrice = parseFloat(ticker.lastPrice);
      
      // 设置卖出价格
      const sellPrice = this.tradingStrategy.calculateOptimalSellPrice(currentPrice, this.tradingCoin);
      const quantity = Formatter.adjustQuantityToStepSize(parseFloat(position.quantity), this.tradingCoin, this.config);
      
      log(`准备卖出: ${quantity} ${this.tradingCoin}, 当前市场价=${currentPrice}, 卖出价=${sellPrice}`);
      
      // 创建卖出订单
      const response = await this.backpackService.createSellOrder(
        this.symbol,
        sellPrice,
        quantity,
        this.tradingCoin
      );
      
      if (response && response.id) {
        log(`卖出订单创建成功: 订单ID=${response.id}, 状态=${response.status}`);
        
        // 检查订单是否完全成交
        let fullyFilled = response.status === 'Filled';
        
        // 如果订单未完全成交，尝试再次以更低价格卖出剩余部分
        if (!fullyFilled) {
          log('订单未完全成交，检查剩余数量并尝试以更低价格卖出');
          
          // 等待一小段时间，让订单有时间处理
          await TimeUtils.delay(2000);
          
          // 获取更新后的持仓
          const updatedPosition = await this.backpackService.getPosition(this.symbol);
          if (updatedPosition && parseFloat(updatedPosition.quantity) > 0) {
            const remainingQuantity = Formatter.adjustQuantityToStepSize(parseFloat(updatedPosition.quantity), this.tradingCoin, this.config);
            
            log(`仍有 ${remainingQuantity} ${this.tradingCoin} 未售出，尝试以更低价格卖出`);
            
            // 计算更低的卖出价格
            const lowerSellPrice = this.tradingStrategy.calculateSecondSellPrice(currentPrice, this.tradingCoin);
            
            // 创建第二次卖出订单
            const secondResponse = await this.backpackService.createSellOrder(
              this.symbol,
              lowerSellPrice,
              remainingQuantity,
              this.tradingCoin
            );
            
            if (secondResponse && secondResponse.id) {
              log(`第二次卖出订单创建成功: 订单ID=${secondResponse.id}, 状态=${secondResponse.status}`);
            }
          } else {
            log(`所有 ${this.tradingCoin} 已售出`);
          }
        }
        
        return response;
      } else {
        throw new Error('卖出订单创建失败：响应中没有订单ID');
      }
    } catch (error) {
      log(`卖出失败: ${error.message}`, true);
      return null;
    }
  }
  
  /**
   * 显示账户信息
   */
  displayAccountInfo() {
    try {
      // 准备数据
      const timeNow = new Date().toLocaleString();
      const takeProfitPercentage = this.config.trading.takeProfitPercentage;
      const elapsedTime = TimeUtils.getElapsedTime(this.scriptStartTime);
      
      // 价格信息
      let priceInfo = "等待WebSocket数据...";
      let priceChangeSymbol = "";
      let percentProgress = "0";
      
      // 获取当前的WebSocket连接状态
      let wsConnected = this.priceMonitor.isMonitoring();
      
      // 显示WebSocket连接状态及上次更新时间
      let wsStatusInfo = wsConnected ? "已连接" : "连接中...";
      
      // 如果有价格监控的上次更新时间，显示距离上次更新的时间
      if (this.priceMonitor.lastUpdateTime) {
        const lastUpdateTimeString = new Date(this.priceMonitor.lastUpdateTime).toLocaleTimeString();
        const dataAge = Math.floor((Date.now() - this.priceMonitor.lastUpdateTime) / 1000);
        wsStatusInfo += ` (${lastUpdateTimeString}, ${dataAge}秒前)`;
      }
      
      // 尝试所有可能的来源获取价格数据
      let priceFound = false;
      
      // 1. 首先尝试使用已有的价格信息
      if (this.currentPriceInfo && this.currentPriceInfo.price) {
        const currentPrice = this.currentPriceInfo.price;
        priceInfo = `${currentPrice.toFixed(1)} USDC`;
        
        // 如果有价格数据来源，显示来源
        if (this.currentPriceInfo.source) {
          priceInfo += ` (来源: ${this.currentPriceInfo.source})`;
        }
        
        priceFound = true;
      } 
      // 2. 如果没有价格信息，尝试从PriceMonitor获取
      else if (this.priceMonitor && this.priceMonitor.currentPrice > 0) {
        const currentPrice = this.priceMonitor.currentPrice;
        priceInfo = `${currentPrice.toFixed(1)} USDC (来源: 监控模块)`;
        
        // 更新到应用状态
        this.currentPriceInfo = {
          price: currentPrice,
          source: '监控模块',
          updateTime: this.priceMonitor.lastUpdateTime || Date.now()
        };
        
        priceFound = true;
      } 
      // 3. 如果仍然没有价格，尝试从WebSocketManager直接获取
      else if (this.priceMonitor && this.priceMonitor.wsManager && 
              this.priceMonitor.wsManager.lastPriceData && 
              this.priceMonitor.wsManager.lastPriceData.price > 0) {
        
        const wsPrice = this.priceMonitor.wsManager.lastPriceData;
        const currentPrice = wsPrice.price;
        priceInfo = `${currentPrice.toFixed(1)} USDC (来源: WebSocket直接获取)`;
        
        // 更新到应用状态
        this.currentPriceInfo = {
          price: currentPrice,
          source: 'WebSocket直接获取',
          updateTime: wsPrice.time || Date.now()
        };
        
        priceFound = true;
      }
      // 4. 尝试从API获取最新价格
      else if (!priceFound) {
        try {
          this.backpackService.getTicker(this.symbol)
            .then(ticker => {
              if (ticker && ticker.lastPrice) {
                const apiPrice = parseFloat(ticker.lastPrice);
                // 只更新状态，不直接影响当前显示
                this.currentPriceInfo = {
                  price: apiPrice,
                  source: 'API请求',
                  updateTime: Date.now()
                };
                
                // 在下一次调用displayAccountInfo时会使用这个价格
                log(`从API获取到价格: ${apiPrice} USDC`);
              }
            })
            .catch(error => {
              log(`API获取价格失败: ${error.message}`);
            });
        } catch (apiError) {
          // 如果API请求失败，静默处理
        }
      }
      
      // 如果找到了价格数据并且有成交均价，计算涨跌幅和进度
      if (priceFound && this.tradeStats.averagePrice > 0) {
        const currentPrice = this.currentPriceInfo.price;
        // 计算涨跌幅
        const priceChange = ((currentPrice - this.tradeStats.averagePrice) / this.tradeStats.averagePrice) * 100;
        this.currentPriceInfo.increase = priceChange;
        
        const absChange = Math.abs(priceChange).toFixed(2);
        priceChangeSymbol = priceChange >= 0 ? "↑" : "↓";
        
        // 计算离止盈目标的进度百分比
        if (priceChange > 0 && takeProfitPercentage > 0) {
          percentProgress = this.tradingStrategy.calculateProgressPercentage(
            currentPrice, 
            this.tradeStats.averagePrice, 
            takeProfitPercentage
          ).toFixed(0);
        }
      }
      
      // 计算盈亏情况
      let currentValue = 0;
      let profit = 0;
      let profitPercent = 0;
      
      if (this.tradeStats.filledOrders > 0 && this.currentPriceInfo && this.currentPriceInfo.price && this.tradeStats.totalFilledQuantity > 0) {
        currentValue = this.currentPriceInfo.price * this.tradeStats.totalFilledQuantity;
        profit = currentValue - this.tradeStats.totalFilledAmount;
        profitPercent = profit / this.tradeStats.totalFilledAmount * 100;
      }
      
      // 格式化并显示
      const data = {
        timeNow,
        symbol: this.symbol,
        scriptStartTime: this.scriptStartTime.toLocaleString(),
        elapsedTime,
        wsStatusInfo,
        priceInfo,
        priceChangeSymbol,
        increase: this.currentPriceInfo?.increase || 0,
        takeProfitPercentage,
        percentProgress,
        stats: this.tradeStats,
        tradingCoin: this.tradingCoin,
        currentValue,
        profit,
        profitPercent,
        priceSource: this.currentPriceInfo?.source
      };
      
      // 格式化并显示
      const display = Formatter.formatAccountInfo(data);
      console.clear();
      console.log(display);
      
      this.displayInitialized = true;
    } catch (error) {
      // 如果显示过程出错，回退到简单显示
      log(`显示信息时发生错误: ${error.message}`);
      // 简单显示函数
      console.log(`\n价格: ${this.currentPriceInfo?.price || '未知'} USDC`);
      console.log(`订单: ${this.tradeStats.filledOrders}/${this.tradeStats.totalOrders}`);
      console.log(`错误: ${error.message}`);
    }
  }
  
  /**
   * 显示统计信息
   */
  displayStats() {
    const stats = this.tradeStats;
    
    log('\n=== 订单统计信息 ===');
    log(`总挂单次数: ${stats.totalOrders}`);
    log(`已成交订单: ${stats.filledOrders}`);
    log(`总成交金额: ${stats.totalFilledAmount.toFixed(2)} USDC`);
    log(`总成交数量: ${stats.totalFilledQuantity.toFixed(6)}`);
    log(`平均成交价格: ${stats.averagePrice.toFixed(2)} USDC`);
    
    // 计算并显示盈亏情况
    if (stats.filledOrders > 0 && this.currentPriceInfo && this.currentPriceInfo.price && stats.totalFilledQuantity > 0) {
      const currentValue = this.currentPriceInfo.price * stats.totalFilledQuantity;
      const cost = stats.totalFilledAmount;
      const profit = currentValue - cost;
      const profitPercent = (profit / cost * 100);
      
      // 添加颜色指示
      const profitSymbol = profit >= 0 ? '+' : '-';
      log(`当前持仓价值: ${currentValue.toFixed(2)} USDC`);
      log(`当前市场价格: ${this.currentPriceInfo.price.toFixed(2)} USDC (${profitSymbol}${Math.abs(this.currentPriceInfo.increase).toFixed(2)}%)`);
      log(`盈亏金额: ${profitSymbol}${Math.abs(profit).toFixed(2)} USDC`);
      log(`盈亏百分比: ${profitSymbol}${Math.abs(profitPercent).toFixed(2)}%`);
    }
    
    log(`最后更新时间: ${stats.lastUpdateTime ? stats.lastUpdateTime.toLocaleString() : '无'}`);
    log('==================\n');
  }
  
  /**
   * 重置应用状态
   */
  resetAppState() {
    // 重置全局配置的一些状态
    this.scriptStartTime = new Date();
    this.tradeStats.reset();
    this.orderManager.reset();
    
    // 重置监控状态
    this.takeProfitTriggered = false;
    this.currentPriceInfo = null;
    this.displayInitialized = false;
    this.cycleLogFile = this.logger.createCycleLogFile();
    
    log('已完全重置所有订单记录和统计数据');
  }
  
  /**
   * 是否达到止盈条件
   */
  isTakeProfitTriggered() {
    return this.takeProfitTriggered;
  }
  
  /**
   * 检查是否需要重启
   */
  isRestartNeeded() {
    return this.needRestart;
  }
  
  /**
   * 检查应用是否正在运行
   */
  isRunning() {
    return this.running;
  }
}

module.exports = TradingApp; 