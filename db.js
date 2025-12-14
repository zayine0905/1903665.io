// db.js - IndexedDB 数据库封装
class ChatDatabase {
    constructor() {
        this.dbName = 'CHAT_APP_V4_DB';
        this.dbVersion = 2; // 版本 2 增加更多存储表
        this.db = null;
    }

    // 打开数据库连接
    async open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                console.log('数据库连接成功');
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                console.log('数据库升级中，版本:', event.oldVersion, '→', event.newVersion);

                // 创建会话存储表
                if (!db.objectStoreNames.contains('sessions')) {
                    const sessionStore = db.createObjectStore('sessions', { keyPath: 'id' });
                    sessionStore.createIndex('createdAt', 'createdAt', { unique: false });
                    console.log('创建 sessions 表');
                }

                // 创建消息存储表
                if (!db.objectStoreNames.contains('messages')) {
                    const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
                    msgStore.createIndex('sessionId', 'sessionId', { unique: false });
                    msgStore.createIndex('timestamp', 'timestamp', { unique: false });
                    console.log('创建 messages 表');
                }

                // 创建资源存储表（头像、表情包、背景图）
                if (!db.objectStoreNames.contains('resources')) {
                    const resStore = db.createObjectStore('resources', { keyPath: 'id' });
                    resStore.createIndex('sessionId_type', ['sessionId', 'type'], { unique: false });
                    console.log('创建 resources 表');
                }

                // 创建设置存储表
                if (!db.objectStoreNames.contains('settings')) {
                    const settingsStore = db.createObjectStore('settings', { keyPath: 'sessionId' });
                    console.log('创建 settings 表');
                }

                // 创建自定义回复表
                if (!db.objectStoreNames.contains('customReplies')) {
                    const repliesStore = db.createObjectStore('customReplies', { keyPath: 'id' });
                    repliesStore.createIndex('sessionId', 'sessionId', { unique: false });
                    console.log('创建 customReplies 表');
                }

                // 创建纪念日表
                if (!db.objectStoreNames.contains('anniversaries')) {
                    const annStore = db.createObjectStore('anniversaries', { keyPath: 'id' });
                    annStore.createIndex('sessionId', 'sessionId', { unique: false });
                    console.log('创建 anniversaries 表');
                }
            };
        });
    }

    // 检查数据库是否已初始化
    async isInitialized() {
        return this.db !== null;
    }

    // 获取会话列表
    async getSessions() {
        if (!this.db) await this.open();
        const tx = this.db.transaction('sessions', 'readonly');
        const store = tx.objectStore('sessions');
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    // 创建新会话
    async createSession(sessionData) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('sessions', 'readwrite');
        const store = tx.objectStore('sessions');
        return new Promise((resolve, reject) => {
            const request = store.add(sessionData);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // 更新会话信息
    async updateSession(sessionId, updates) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('sessions', 'readwrite');
        const store = tx.objectStore('sessions');
        return new Promise((resolve, reject) => {
            const getRequest = store.get(sessionId);
            getRequest.onsuccess = () => {
                const session = getRequest.result;
                if (session) {
                    const updatedSession = { ...session, ...updates };
                    const putRequest = store.put(updatedSession);
                    putRequest.onsuccess = () => resolve();
                    putRequest.onerror = () => reject(putRequest.error);
                } else {
                    reject(new Error('会话不存在'));
                }
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    // 删除会话及其所有数据
    async deleteSession(sessionId) {
        if (!this.db) await this.open();
        const tx = this.db.transaction(
            ['sessions', 'messages', 'resources', 'settings', 'customReplies', 'anniversaries'],
            'readwrite'
        );

        // 删除会话本身
        tx.objectStore('sessions').delete(sessionId);

        // 删除消息
        const deleteFromStore = async (storeName, indexName) => {
            const store = tx.objectStore(storeName);
            const index = store.index(indexName);
            return new Promise((resolve) => {
                const request = index.openCursor(IDBKeyRange.only(sessionId));
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        cursor.delete();
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
                request.onerror = () => resolve(); // 出错也继续
            });
        };

        // 并行删除各表数据
        await Promise.all([
            deleteFromStore('messages', 'sessionId'),
            deleteFromStore('customReplies', 'sessionId'),
            deleteFromStore('anniversaries', 'sessionId')
        ]);

        // 删除资源（需要复合索引）
        const deleteResources = () => {
            return new Promise((resolve) => {
                const store = tx.objectStore('resources');
                const index = store.index('sessionId_type');
                const range = IDBKeyRange.bound([sessionId, ''], [sessionId, '\uffff']);
                const request = index.openCursor(range);
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        cursor.delete();
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
                request.onerror = () => resolve();
            });
        };

        await deleteResources();

        // 删除设置
        tx.objectStore('settings').delete(sessionId);

        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // 保存消息（批量）
    async saveMessages(sessionId, messages) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');

        // 先删除该会话的所有旧消息
        await new Promise((resolve) => {
            const index = store.index('sessionId');
            const request = index.openCursor(IDBKeyRange.only(sessionId));
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = () => resolve();
        });

        // 插入新消息
        messages.forEach(msg => {
            if (!msg.sessionId) {
                msg.sessionId = sessionId;
            }
            if (!msg.id) {
                msg.id = `${sessionId}_msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            }
            store.add(msg);
        });

        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // 加载消息
    async loadMessages(sessionId) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('messages', 'readonly');
        const store = tx.objectStore('messages');
        const index = store.index('sessionId');
        return new Promise((resolve, reject) => {
            const request = index.getAll(IDBKeyRange.only(sessionId));
            request.onsuccess = () => {
                const messages = request.result || [];
                // 按时间排序
                messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                resolve(messages);
            };
            request.onerror = () => reject(request.error);
        });
    }

    // 添加单条消息
    async addMessage(sessionId, message) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        
        if (!message.sessionId) {
            message.sessionId = sessionId;
        }
        if (!message.id) {
            message.id = `${sessionId}_msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }
        
        return new Promise((resolve, reject) => {
            const request = store.add(message);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // 更新消息（例如标记已读、收藏）
    async updateMessage(messageId, updates) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        return new Promise((resolve, reject) => {
            const getRequest = store.get(messageId);
            getRequest.onsuccess = () => {
                const message = getRequest.result;
                if (message) {
                    const updatedMessage = { ...message, ...updates };
                    const putRequest = store.put(updatedMessage);
                    putRequest.onsuccess = () => resolve();
                    putRequest.onerror = () => reject(putRequest.error);
                } else {
                    reject(new Error('消息不存在'));
                }
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    // 保存资源（头像、表情包、背景图）
    async saveResource(sessionId, type, key, data) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('resources', 'readwrite');
        const store = tx.objectStore('resources');
        const id = `${sessionId}_${type}_${key}`;
        const item = { 
            id, 
            sessionId, 
            type, 
            key, 
            data, 
            timestamp: Date.now() 
        };
        return new Promise((resolve, reject) => {
            const request = store.put(item);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // 加载资源
    async loadResource(sessionId, type, key) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('resources', 'readonly');
        const store = tx.objectStore('resources');
        const id = `${sessionId}_${type}_${key}`;
        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result ? request.result.data : null);
            request.onerror = () => reject(request.error);
        });
    }

    // 删除资源
    async deleteResource(sessionId, type, key) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('resources', 'readwrite');
        const store = tx.objectStore('resources');
        const id = `${sessionId}_${type}_${key}`;
        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // 获取会话的所有特定类型资源
    async loadResourcesByType(sessionId, type) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('resources', 'readonly');
        const store = tx.objectStore('resources');
        const index = store.index('sessionId_type');
        return new Promise((resolve, reject) => {
            const request = index.getAll([sessionId, type]);
            request.onsuccess = () => {
                const results = request.result || [];
                // 按时间倒序排序
                results.sort((a, b) => b.timestamp - a.timestamp);
                resolve(results.map(r => r.data));
            };
            request.onerror = () => reject(request.error);
        });
    }

    // 保存设置
    async saveSettings(sessionId, settings) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('settings', 'readwrite');
        const store = tx.objectStore('settings');
        const item = { sessionId, ...settings };
        return new Promise((resolve, reject) => {
            const request = store.put(item);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // 加载设置
    async loadSettings(sessionId) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('settings', 'readonly');
        const store = tx.objectStore('settings');
        return new Promise((resolve, reject) => {
            const request = store.get(sessionId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    // 保存自定义回复
    async saveCustomReplies(sessionId, replies) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('customReplies', 'readwrite');
        const store = tx.objectStore('customReplies');

        // 先删除旧的
        await new Promise((resolve) => {
            const index = store.index('sessionId');
            const request = index.openCursor(IDBKeyRange.only(sessionId));
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = () => resolve();
        });

        // 插入新的
        replies.forEach((reply, idx) => {
            const item = {
                id: `${sessionId}_reply_${Date.now()}_${idx}`,
                sessionId,
                text: reply.text,
                enabled: reply.enabled !== false,
                timestamp: Date.now()
            };
            store.add(item);
        });

        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // 加载自定义回复
    async loadCustomReplies(sessionId) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('customReplies', 'readonly');
        const store = tx.objectStore('customReplies');
        const index = store.index('sessionId');
        return new Promise((resolve, reject) => {
            const request = index.getAll(IDBKeyRange.only(sessionId));
            request.onsuccess = () => {
                const replies = request.result || [];
                // 过滤启用的回复并按时间倒序
                const enabledReplies = replies
                    .filter(r => r.enabled !== false)
                    .sort((a, b) => b.timestamp - a.timestamp)
                    .map(r => ({ text: r.text, id: r.id }));
                resolve(enabledReplies);
            };
            request.onerror = () => reject(request.error);
        });
    }

    // 保存纪念日
    async saveAnniversaries(sessionId, anniversaries) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('anniversaries', 'readwrite');
        const store = tx.objectStore('anniversaries');

        // 先删除旧的
        await new Promise((resolve) => {
            const index = store.index('sessionId');
            const request = index.openCursor(IDBKeyRange.only(sessionId));
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = () => resolve();
        });

        // 插入新的
        anniversaries.forEach((ann, idx) => {
            const item = {
                id: `${sessionId}_ann_${Date.now()}_${idx}`,
                sessionId,
                name: ann.name,
                date: ann.date,
                type: ann.type || 'anniversary',
                createdAt: Date.now()
            };
            store.add(item);
        });

        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // 加载纪念日
    async loadAnniversaries(sessionId) {
        if (!this.db) await this.open();
        const tx = this.db.transaction('anniversaries', 'readonly');
        const store = tx.objectStore('anniversaries');
        const index = store.index('sessionId');
        return new Promise((resolve, reject) => {
            const request = index.getAll(IDBKeyRange.only(sessionId));
            request.onsuccess = () => {
                const anniversaries = request.result || [];
                // 按日期排序
                anniversaries.sort((a, b) => new Date(a.date) - new Date(b.date));
                resolve(anniversaries.map(r => ({
                    name: r.name,
                    date: r.date,
                    type: r.type || 'anniversary'
                })));
            };
            request.onerror = () => reject(request.error);
        });
    }

    // 获取数据库统计信息
    async getStats() {
        if (!this.db) await this.open();
        const stats = {};
        
        // 统计各表数据量
        const tables = ['sessions', 'messages', 'resources', 'settings', 'customReplies', 'anniversaries'];
        
        for (const table of tables) {
            const tx = this.db.transaction(table, 'readonly');
            const store = tx.objectStore(table);
            const count = await new Promise((resolve) => {
                const request = store.count();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(0);
            });
            stats[table] = count;
        }
        
        return stats;
    }

    // 清理旧数据
    async cleanupOldData(maxAgeDays = 180) {
        if (!this.db) await this.open();
        const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
        
        // 清理旧资源
        const tx = this.db.transaction('resources', 'readwrite');
        const store = tx.objectStore('resources');
        
        await new Promise((resolve) => {
            const request = store.openCursor();
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (cursor.value.timestamp < cutoff) {
                        cursor.delete();
                    }
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = () => resolve();
        });
        
        console.log('旧数据清理完成');
    }
}

// 创建全局实例
const chatDB = new ChatDatabase();

// 导出以便在控制台调试
if (typeof window !== 'undefined') {
    window.chatDB = chatDB;
}