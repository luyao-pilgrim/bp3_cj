const fs = require('fs');
const path = require('path');

/**
 * 日志工具类 - 负责记录日志到控制台和文件
 */
class Logger {
  /**
   * 构造函数
   * @param {Object} options - 日志选项
   * @param {string} options.logDir - 日志目录
   * @param {string} options.prefix - 日志文件前缀
   */
  constructor(options = {}) {
    this.logDir = options.logDir || path.join(process.cwd(), 'logs');
    this.prefix = options.prefix || 'trading';
    
    // 确保日志目录存在
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }
  
  /**
   * 获取当前日期字符串，格式为YYYY-MM-DD
   * @returns {string} 日期字符串
   */
  getDateString() {
    return new Date().toISOString().split('T')[0];
  }
  
  /**
   * 记录日志
   * @param {string} message - 日志消息
   * @param {boolean} isError - 是否为错误日志
   * @param {boolean} displayOnConsole - 是否在控制台显示
   */
  log(message, isError = false, displayOnConsole = true) {
    const timestamp = new Date().toLocaleString();
    const logMessage = `[${timestamp}] ${message}`;
    
    // 根据参数决定是否在控制台显示
    if (displayOnConsole) {
      if (isError) {
        console.error(logMessage);
      } else {
        console.log(logMessage);
      }
    }
    
    // 获取当前日期
    const date = this.getDateString();
    
    // 生成普通日志文件路径
    const logFile = path.join(this.logDir, `${this.prefix}_${date}.log`);
    
    // 写入普通日志
    fs.appendFileSync(
      logFile, 
      logMessage + '\n', 
      { encoding: 'utf8' }
    );
    
    // 如果是错误，还要写入错误日志
    if (isError) {
      const errorLogFile = path.join(this.logDir, `error_${date}.log`);
      fs.appendFileSync(
        errorLogFile,
        logMessage + '\n',
        { encoding: 'utf8' }
      );
    }
  }
  
  /**
   * 只记录到日志文件，不在控制台显示
   * @param {string} message - 日志消息
   * @param {boolean} isError - 是否为错误日志
   */
  logToFile(message, isError = false) {
    this.log(message, isError, false);
  }
  
  /**
   * 创建交易周期日志文件
   * @returns {string} 周期日志文件路径
   */
  createCycleLogFile() {
    const date = this.getDateString();
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const cycleLogFile = path.join(this.logDir, `auto_trading_cycle_${date}_${timestamp}.log`);
    return cycleLogFile;
  }
  
  /**
   * 记录订单到交易周期日志
   * @param {string} logFile - 周期日志文件路径
   * @param {Object} order - 订单信息
   * @param {Object} config - 配置信息
   */
  logOrderToCycle(logFile, order, config) {
    try {
      if (!logFile) return;
      
      const timestamp = new Date().toLocaleString();
      const logEntry = {
        timestamp,
        orderId: order.id,
        symbol: order.symbol || config.symbol,
        price: order.price,
        quantity: order.quantity,
        status: order.status,
        side: order.side,
        filled: order.status === 'Filled'
      };
      
      fs.appendFileSync(
        logFile,
        JSON.stringify(logEntry) + '\n',
        { encoding: 'utf8' }
      );
    } catch (error) {
      this.log(`记录订单到周期日志失败: ${error.message}`, true, false);
    }
  }
  
  /**
   * 专门记录API错误的方法
   * @param {Error} error - 错误对象
   * @param {string} context - 错误上下文描述
   * @param {Object} params - API调用参数
   */
  logApiError(error, context, params = {}) {
    // 构建基本错误信息
    let messages = [];
    messages.push(`[API错误] ${context}: ${error.message}`);
    
    // 记录API调用参数
    if (Object.keys(params).length > 0) {
      messages.push(`请求参数: ${JSON.stringify(params)}`);
    }
    
    // 处理响应错误
    if (error.response) {
      const { status, statusText, data } = error.response;
      messages.push(`响应状态: ${status} (${statusText || 'No status text'})`);
      
      // 记录响应数据
      if (data) {
        messages.push(`响应数据: ${JSON.stringify(data)}`);
        
        // 提取错误信息
        if (data.message) messages.push(`错误消息: ${data.message}`);
        if (data.code) messages.push(`错误代码: ${data.code}`);
        if (data.error) messages.push(`错误详情: ${JSON.stringify(data.error)}`);
      }
    }
    
    // 记录请求信息
    if (error.request) {
      const { method, path, headers } = error.request;
      messages.push(`请求方法: ${method || 'N/A'}`);
      messages.push(`请求URL: ${path || 'N/A'}`);
      
      // 可选: 记录请求头 (可能包含敏感信息，谨慎使用)
      // messages.push(`请求头: ${JSON.stringify(headers || {})}`);
    }
    
    // 记录错误堆栈
    if (error.stack) {
      messages.push(`堆栈: ${error.stack}`);
    }
    
    // 将所有信息写入日志
    messages.forEach(msg => this.log(msg, true));
    
    // 同时写入错误专用日志文件
    const date = this.getDateString();
    const apiErrorLogFile = path.join(this.logDir, `api_error_${date}.log`);
    
    fs.appendFileSync(
      apiErrorLogFile,
      `\n--- API错误 [${new Date().toISOString()}] ---\n${messages.join('\n')}\n`,
      { encoding: 'utf8' }
    );
  }
}

// 创建默认实例
const defaultLogger = new Logger();

module.exports = {
  Logger,
  defaultLogger,
  log: (...args) => defaultLogger.log(...args),
  logToFile: (...args) => defaultLogger.logToFile(...args)
}; 