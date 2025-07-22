'use strict';
const COS = require('cos-nodejs-sdk-v5');
const { v4: uuidv4 } = require('uuid');

// ===========================
// 配置区域 - 硬编码配置参数
// ===========================
const CONFIG = {
    // COS存储配置
    cos: {
        secretId: '', // 替换为有效SecretId
        secretKey: '', // 替换为有效SecretKey
        bucket: '', // 确认Bucket名称正确
        region: '', // 确认区域与Bucket一致
        paths: {
            sentCards: '',
            receivedCards: ''
        }
    },
    // 支持的操作列表
    supportedActions: ['ping', 'getStats', 'getChartData', 'getSentCards', 'getReceivedCards', 'saveCard', 'deleteCard']
};

// ===========================
// 初始化区域
// ===========================
// 初始化COS客户端
const cos = new COS({
    SecretId: CONFIG.cos.secretId,
    SecretKey: CONFIG.cos.secretKey
});

// 自定义错误类
class QslError extends Error {
    constructor(message, code = -1, statusCode = 500) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
    }
}

// ===========================
// COS核心操作区域
// ===========================
/**
 * 从COS读取JSON数据
 * @param {string} key - COS对象键
 * @returns {Promise<Array>} - 解析后的JSON数据数组
 */
async function readFromCos(key) {
    try {
        const result = await cos.getObject({
            Bucket: CONFIG.cos.bucket,
            Region: CONFIG.cos.region,
            Key: key
        });

        // 添加请求成功日志
        console.log(`[COS] 读取成功 (${key}):`, result.headers['x-cos-request-id']);

        // 处理空文件和JSON解析
        const content = result.Body.toString('utf8').trim();
        return content ? JSON.parse(content) : [];
    } catch (error) {
        // 详细错误日志，包含所有可用信息
        console.error(`[COS] 读取失败 (${key}):`, {
            code: error.code,
            message: error.message,
            requestId: error.requestId,
            statusCode: error.statusCode,
            headers: error.headers,
            bucket: CONFIG.cos.bucket,
            region: CONFIG.cos.region
        });

        // 更具体的错误分类
        if (error.code === 'NoSuchKey') return [];
        if (error.code === 'SignatureDoesNotMatch') {
            throw new QslError(`COS签名验证失败: 请检查SecretId/SecretKey和区域配置 (RequestId: ${error.requestId})`, 1001, 403);
        }
        if (error.code === 'AccessDenied') {
            throw new QslError(`访问权限不足: 请检查密钥权限配置 (RequestId: ${error.requestId})`, 1002, 403);
        }
        if (error.code === 'InvalidBucketName') {
            throw new QslError(`Bucket名称无效: ${CONFIG.cos.bucket} (RequestId: ${error.requestId})`, 1003, 400);
        }
        if (error.code === 'InvalidRegion') {
            throw new QslError(`区域配置无效: ${CONFIG.cos.region} (RequestId: ${error.requestId})`, 1004, 400);
        }

        // 通用错误
        throw new QslError(`数据读取失败: ${error.message} (${error.code})`, 1005, 500);
    }
}

/**
 * 向COS写入JSON数据
 * @param {string} key - COS对象键
 * @param {Array} data - 要写入的数据数组
 * @returns {Promise<void>}
 */
async function writeToCos(key, data) {
    if (!Array.isArray(data)) {
        throw new QslError('写入的数据必须是数组', 1002, 400);
    }

    try {
        await cos.putObject({
            Bucket: CONFIG.cos.bucket,
            Region: CONFIG.cos.region,
            Key: key,
            Body: JSON.stringify(data, null, 2),
            ContentType: 'application/json'
        });
    } catch (error) {
        console.error(`[COS] 写入失败 (${key}):`, error);
        throw new QslError(`数据保存失败: ${error.message}`, 1003, 500);
    }
}

// ===========================
// 数据验证区域
// ===========================
/**
 * 验证QSL卡片数据
 * @param {Object} card - 卡片数据
 * @param {boolean} isSentCard - 是否为已发送卡片
 * @throws {QslError} - 验证失败时抛出错误
 */
function validateCardData(card, isSentCard = true) {
    const errors = [];

    // 通用字段验证
    if (!card.callSign?.trim()) errors.push('对方呼号不能为空');
    if (!card.myCallSign?.trim()) errors.push('我的呼号不能为空');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(card.date)) errors.push('通联日期格式不正确(YYYY-MM-DD)');
    if (!card.mode?.trim()) errors.push('通信模式不能为空');
    if (!['online', 'physical'].includes(card.cardType)) errors.push('卡片类型必须是online或physical');
    // 删除状态相关验证代码
    if (isSentCard && !['pending', 'sent'].includes(card.status)) {
        errors.push('已发送卡片状态必须是pending或sent');
    }
    if (!isSentCard && card.status && !['received', 'verified'].includes(card.status)) {
        errors.push('已接收卡片状态必须是received或verified');
    }

    if (errors.length > 0) {
        throw new QslError(`卡片数据验证失败: ${errors.join('; ')}`, 2001, 400);
    }
}

// ===========================
// 业务逻辑区域
// ===========================
/**
 * 获取系统状态
 * @returns {Object} - 系统状态信息
 */
function getSystemStatus() {
    return {
        status: 'normal',
        message: '服务正常运行中',
        timestamp: new Date().toISOString()
    };
}

/**
 * 获取统计数据
 * @returns {Promise<Object>} - 统计信息
 */
async function getStats() {
    const sentCards = await readFromCos(CONFIG.cos.paths.sentCards);
    const receivedCards = await readFromCos(CONFIG.cos.paths.receivedCards);

    // 提取国家信息（简化处理）
    const countries = new Set();
    [...sentCards, ...receivedCards].forEach(card => {
        if (card.callSign) {
            const country = card.callSign.substring(0, 2).toUpperCase();
            countries.add(country);
        }
    });

    // 计算EYE模式通联数量
    const eyeQsoCount = [...sentCards, ...receivedCards]
        .filter(card => card.mode?.toLowerCase() === 'eye')
        .length;

    return {
        received: receivedCards.length,
        sent: sentCards.length,
        pending: sentCards.filter(card => card.status === 'pending').length,
        countries: countries.size,
        eyeQso: eyeQsoCount,
        // 删除百分比计算相关代码
        // 模拟增长率数据
        receivedGrowth: Math.floor(Math.random() * 20) + 1,
        sentGrowth: Math.floor(Math.random() * 20) + 1,
        countryGrowth: Math.floor(Math.random() * 10) + 1
    };
}

/**
 * 获取图表数据
 * @returns {Promise<Object>} - 图表所需数据
 */
async function getChartData() {
    const sentCards = await readFromCos(CONFIG.cos.paths.sentCards);
    const receivedCards = await readFromCos(CONFIG.cos.paths.receivedCards);

    // 生成月度统计数据（近6个月）
    const months = [];
    const monthlySent = [];
    const monthlyReceived = [];
    const monthlyPending = [];

    for (let i = 5; i >= 0; i--) {
        const date = new Date();
        date.setMonth(date.getMonth() - i);
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

        months.push(monthKey);

        // 使用卡片的实际通联时间(date字段)进行统计
        monthlySent.push(sentCards.filter(card => {
            if (!card.date) return false;
            const cardDate = new Date(card.date);
            // 处理无效日期
            if (isNaN(cardDate.getTime())) return false;
            return `${cardDate.getFullYear()}-${String(cardDate.getMonth() + 1).padStart(2, '0')}` === monthKey;
        }).length);

        monthlyPending.push(sentCards.filter(card => {
            if (!card.date) return false;
            const cardDate = new Date(card.date);
            if (isNaN(cardDate.getTime())) return false;
            return `${cardDate.getFullYear()}-${String(cardDate.getMonth() + 1).padStart(2, '0')}` === monthKey;
        }).length);

        monthlyReceived.push(receivedCards.filter(card => {
            if (!card.date) return false;
            const cardDate = new Date(card.date);
            if (isNaN(cardDate.getTime())) return false;
            return `${cardDate.getFullYear()}-${String(cardDate.getMonth() + 1).padStart(2, '0')}` === monthKey;
        }).length);
    }

    // 生成模式分布数据
    const modes = {};
    [...sentCards, ...receivedCards].forEach(card => {
        const mode = card.mode?.toUpperCase() || 'OTHER';
        modes[mode] = (modes[mode] || 0) + 1;
    });

    return {
        monthly: {
            labels: months,
            sent: monthlySent,
            pending: monthlyPending,
            received: monthlyReceived
        },
        modes: {
            labels: Object.keys(modes),
            data: Object.values(modes)
        }
    };
}

/**
 * 保存卡片数据
 * @param {Object} cardData - 卡片数据
 * @param {boolean} isSentCard - 是否为已发送卡片
 * @returns {Promise<Object>} - 保存后的卡片信息
 */
async function saveCard(cardData, isSentCard = true) {
    // 验证卡片数据
    validateCardData(cardData, isSentCard);

    // 获取存储路径
    const path = isSentCard ? CONFIG.cos.paths.sentCards : CONFIG.cos.paths.receivedCards;
    const cards = await readFromCos(path);

    // 在saveCard函数中确保状态正确设置
    const newCard = {
        id: uuidv4(),
        ...cardData,
        // 删除状态字段
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    // 添加或更新卡片
    const existingIndex = cards.findIndex(card => card.id === newCard.id);
    if (existingIndex >= 0) {
        cards[existingIndex] = newCard;
    } else {
        cards.push(newCard);
    }

    // 保存到COS
    await writeToCos(path, cards);
    return newCard;
}

/**
 * 删除卡片
 * @param {string} cardId - 卡片ID
 * @param {boolean} isSentCard - 是否为已发送卡片
 * @returns {Promise<boolean>} - 删除结果
 */
async function deleteCard(cardId, isSentCard = true) {
    if (!cardId) {
        throw new QslError('卡片ID不能为空', 2002, 400);
    }

    const path = isSentCard ? CONFIG.cos.paths.sentCards : CONFIG.cos.paths.receivedCards;
    const cards = await readFromCos(path);
    const initialLength = cards.length;

    // 过滤掉要删除的卡片
    const filteredCards = cards.filter(card => card.id !== cardId);

    // 如果数量没变，说明没找到该卡片
    if (filteredCards.length === initialLength) {
        throw new QslError(`未找到ID为${cardId}的卡片`, 2003, 404);
    }

    // 保存更新后的列表
    await writeToCos(path, filteredCards);
    return true;
}

// ===========================
// 请求处理区域
// ===========================
/**
 * 处理API请求
 * @param {Object} event - 请求事件
 * @returns {Promise<Object>} - 响应结果
 */
async function handleRequest(event) {
    // 设置跨域响应头
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };

    // 处理预检请求
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers,
            body: ''
        };
    }

    try {
        // 解析请求参数
        const { action: queryAction, cardId, type } = event.queryString || {};
        let requestBody = {};

        // 解析请求体（处理base64编码情况）
        if (event.body) {
            try {
                if (event.isBase64Encoded) {
                    const decodedBody = Buffer.from(event.body, 'base64').toString('utf8');
                    requestBody = decodedBody ? JSON.parse(decodedBody) : {};
                } else {
                    requestBody = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
                }
            } catch (parseError) {
                throw new QslError(`请求体格式错误: ${parseError.message}`, 3001, 400);
            }
        }

        // 从查询参数或请求体中获取action（查询参数优先）
        const { action: bodyAction } = requestBody;
        const action = queryAction || bodyAction;

        // 验证Action参数
        if (!action || !CONFIG.supportedActions.includes(action)) {
            throw new QslError(
                `请提供有效的action参数，支持的操作: ${CONFIG.supportedActions.join(', ')}`,
                3002, 400
            );
        }

        // 根据action处理不同请求
        let result;
        switch (action) {
            case 'ping':
                result = getSystemStatus();
                break;
            case 'getStats':
                result = await getStats();
                break;
            case 'getChartData':
                result = await getChartData();
                break;
            case 'getSentCards':
                result = await readFromCos(CONFIG.cos.paths.sentCards);
                break;
            case 'getReceivedCards':
                result = await readFromCos(CONFIG.cos.paths.receivedCards);
                break;
            case 'saveCard':
                const isSent = requestBody.type !== 'received';
                result = await saveCard(requestBody.cardData, isSent);
                break;
            case 'deleteCard':
                if (!type) throw new QslError('请指定卡片类型(type=sent/received)', 3003, 400);
                result = await deleteCard(cardId, type === 'sent');
                break;
            default:
                throw new QslError(`未知的action: ${action}`, 3004, 400);
        }

        // 返回成功响应
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                code: 0,
                message: '操作成功',
                data: result,
                requestId: event.requestId || uuidv4()
            })
        };
    } catch (error) {
        // 记录错误日志
        console.error('处理请求失败:', error);

        // 返回错误响应
        const statusCode = error.statusCode || 500;
        return {
            statusCode,
            headers,
            body: JSON.stringify({
                code: error.code || -1,
                message: error.message || '服务器内部错误',
                requestId: event.requestId || uuidv4()
            })
        };
    }
}

// ===========================
// 云函数入口
// ===========================
exports.main_handler = async (event, context) => {
    // 添加context到event，便于内部使用
    event.requestId = context.requestId;
    return handleRequest(event);
};