# Backpack 自动交易系统

这是一个基于 Backpack 交易所的自动交易系统，支持自动买入、止盈和风险控制。

## 文件结构

```
├── start_auto_trading.js      # 主启动脚本
├── test_create_orders_auto.js # 交易执行脚本
├── backpack_trading_config.json # 配置文件
├── backpack_exchange-main/    # Backpack API 客户端
│   └── backpack_client.js
└── logs/                      # 日志目录
    ├── trading_YYYY-MM-DD.log    # 交易日志
    ├── error_YYYY-MM-DD.log      # 错误日志
    └── auto_trading_cycle_YYYY-MM-DD.log # 交易周期日志
```

## 配置文件说明

`backpack_trading_config.json` 包含以下配置项：

```json
{
  "api": {
    "privateKey": "YOUR_PRIVATE_KEY",   // 私钥
    "publicKey": "YOUR_PUBLIC_KEY"      // 公钥
  },
  "trading": {
    "tradingCoin": "BTC",               // 交易币种
    "maxDropPercentage": 7,             // 最大跌幅百分比
    "totalAmount": 1000,                // 总投资金额（USDC）
    "orderCount": 9,                    // 买入订单数量
    "incrementPercentage": 50,          // 每次买入递增百分比
    "takeProfitPercentage": 0.2         // 止盈百分比
  },
  "actions": {
    "sellNonUsdcAssets": true,          // 是否卖出非USDC资产
    "cancelAllOrders": true,            // 是否取消所有订单
    "restartAfterTakeProfit": true,     // 止盈后是否自动重启
    "autoRestartNoFill": true           // 无订单成交是否自动重启
  },
  "advanced": {
    "minOrderAmount": 10,               // 最小订单金额
    "priceTickSize": 0.01,              // 价格最小变动单位
    "checkOrdersIntervalMinutes": 10,   // 订单检查间隔（分钟）
    "monitorIntervalSeconds": 15,       // 监控间隔（秒）
    "sellNonUsdcMinValue": 10,          // 非USDC资产最小卖出价值
    "noFillRestartMinutes": 3           // 无成交重启等待时间（分钟）
  },
  "quantityPrecisions": {               // 数量精度设置
    "BTC": 5,
    "ETH": 4,
    "SOL": 2,
    "DEFAULT": 2
  },
  "pricePrecisions": {                  // 价格精度设置
    "BTC": 0,
    "ETH": 2,
    "SOL": 2,
    "DEFAULT": 2
  },
  "minQuantities": {                    // 最小数量设置
    "BTC": 0.00001,
    "ETH": 0.001,
    "SOL": 0.01,
    "DEFAULT": 0.1
  }
}
```

## 脚本说明

### 1. start_auto_trading.js
主启动脚本，负责：
- 启动交易脚本
- 监控脚本运行状态
- 自动重启功能
- 处理进程终止信号

### 2. test_create_orders_auto.js
交易执行脚本，包含：
- 订单创建逻辑
- 价格监控
- 止盈处理
- 风险控制
- 订单状态更新

### 3. backpack_client.js
Backpack 交易所 API 客户端，处理：
- API 认证
- 订单操作
- 账户查询
- 市场数据获取

## 工作原理

1. **启动流程**：
   - 读取配置文件
   - 启动交易脚本
   - 开始监控价格和订单

2. **交易策略**：
   - 系统会根据配置的参数自动创建多个买入订单
   - 订单价格根据递增百分比逐步降低
   - 监控订单成交情况和市场价格
   - 当成交订单达到止盈目标时自动卖出
   - 当价格下跌超过最大跌幅时进行风险控制

3. **风险控制**：
   - 设置最大跌幅限制
   - 自动取消未成交订单
   - 定期检查订单状态
   - 异常情况自动重启
   - 精确追踪已成交订单

4. **自动重启机制**：
   - 止盈后自动重启新一轮交易
   - 无订单成交自动重启
   - 异常退出自动重启
   - 重启时会重置所有订单记录

## 使用方法

1. **配置设置**：
   ```bash
   # 编辑配置文件
   nano backpack_trading_config.json
   ```

2. **启动程序**：
   ```bash
   # 启动自动交易
   node start_auto_trading.js
   ```

3. **监控运行**：
   - 查看控制台输出
   - 检查日志文件
   - 监控订单状态

4. **停止程序**：
   - 按 Ctrl+C 优雅退出
   - 程序会自动取消所有未成交订单

## 注意事项

1. **风险提示**：
   - 请确保理解交易策略
   - 合理设置止盈止损
   - 注意资金安全

2. **配置建议**：
   - 交易币种选择流动性好的币种
   - 最大跌幅建议 5-10%
   - 订单数量建议 5-10 个
   - 递增百分比建议 30-50%
   - 止盈百分比根据市场波动性调整

3. **API密钥**：
   - 需要提供有效的Backpack交易所API密钥
   - 私钥和公钥必须正确配对
   - 确保API密钥有足够的权限

4. **精度设置**：
   - 不同币种有不同的数量和价格精度要求
   - 可以在配置文件中为每种币种设置特定精度
   - 如果币种没有特定设置，将使用DEFAULT值

## 常见问题

1. **API密钥问题**：
   - 确保提供的私钥和公钥格式正确
   - 验证API密钥是否有足够权限
   - 检查密钥是否已过期

2. **订单未成交**：
   - 检查价格设置是否合理
   - 确认市场流动性是否足够
   - 查看订单状态和日志

3. **统计数据不准确**：
   - 检查日志中的订单跟踪信息
   - 重启系统以重置所有统计数据
   - 确认所有订单记录已正确清除

4. **系统异常退出**：
   - 检查错误日志
   - 验证系统资源
   - 确认网络连接稳定

## 更新日志

### v1.0.1
- 优化订单追踪机制
- 修复统计数据问题
- 改进重启功能
- 增强日志系统

### v1.0.0
- 初始版本发布
- 基本交易功能
- 自动重启机制
- 日志记录系统 