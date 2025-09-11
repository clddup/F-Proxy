import { exit } from "process";
import async from "async";
import { Buffer } from "buffer";
import chalk from 'chalk';
import ProgressBar from 'progress';
import { say } from 'cfonts';
import YAML from 'yaml';

// --- 常量配置 ---
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT || '5', 10);
const REQUEST_TIMEOUT = 5000;
const PROGRESS_BAR_WIDTH = 20;
const FOFA_SEARCH_PATH = "/api/v1/search/all";
const SUBSCRIPTION_REGEX = /(https?:\/\/[^\s\"\'<>`]+\/api\/v1\/client\/subscribe\?token=[a-zA-Z0-9]+)/g;
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
const UNIT_POWERS = UNITS.map((_, i) => Math.pow(1024, i));

// --- Fofa API 配置 ---
const key = process.env.FOFA_KEY;
const fields = "host,protocol,header,banner";
const size = parseInt(process.env.FOFA_SIZE || '20', 10);

// --- 配置验证 ---
function validateConfig() {
    if (!key) {
        console.error(chalk.red("错误：请配置环境变量 FOFA_KEY。"));
        console.log("您可以从 https://fofa.info/userInfo 获取您的key");
        exit(1);
    }
    
    if (size < 1) {
        console.error(chalk.red("错误：FOFA_SIZE 必须大于 0。"));
        exit(1);
    }
    
    if (CONCURRENCY_LIMIT < 1) {
        console.error(chalk.red("错误：CONCURRENCY_LIMIT 必须大于 0。"));
        exit(1);
    }
}

validateConfig();

// --- 类型定义 ---
type Host = string;
type Link = string;

interface FofaTarget {
    host: string;
    protocol: string;
    header: string;
    banner: string;
}

interface PageResult {
    host: Host;
    body: string;
    header: string;
    banner: string;
}

interface SubscriptionUserinfo {
    upload: number;
    download: number;
    total: number;
    expire: number | null;
}

type VerificationResult = {
    link: Link;
    host: Host;
    status: 'success' | 'failed';
    reason?: string;
};

// --- 日志工具 ---
const logger = {
    step: (step: number | string, total: number, title: string) => 
        console.log(chalk.white(`\n--- Step ${step}/${total}: ${title} ---`)),
    info: (message: string) => console.log(chalk.magenta(message)),
    success: (message: string) => console.log(chalk.green(message)),
    error: (message: string) => console.error(chalk.red(message)),
    warning: (message: string) => console.log(chalk.yellow(message)),
    cyan: (message: string) => console.log(chalk.cyan(message))
};

// --- 常量与辅助函数 ---
const CLASH_UA = 'clash';

// 解析 subscription-userinfo 响应头
function parseSubscriptionUserinfo(headerValue: string | null): SubscriptionUserinfo | null {
    if (!headerValue) return null;
    
    const result: SubscriptionUserinfo = { upload: 0, download: 0, total: 0, expire: null };
    
    // 解析格式: upload=123; download=456; total=789; expire=1234567890
    const pairs = headerValue.split(';').map(pair => pair.trim());
    
    for (const pair of pairs) {
        const [key, value] = pair.split('=').map(s => s.trim());
        if (!value) continue;
        const numValue = parseInt(value, 10);
        
        if (key === 'upload' && !isNaN(numValue)) result.upload = numValue;
        else if (key === 'download' && !isNaN(numValue)) result.download = numValue;
        else if (key === 'total' && !isNaN(numValue)) result.total = numValue;
        else if (key === 'expire' && !isNaN(numValue)) result.expire = numValue;
    }
    
    return result;
}

// 优化的流量格式化函数
const parseTraffic = (num?: number): [string, string] => {
    if (typeof num !== "number" || num < 0) return ["NaN", ""];
    if (num < 1000) return [`${Math.round(num)}`, "B"];
    
    const exp = Math.min(Math.floor(Math.log2(num) / 10), UNITS.length - 1);
    const dat = num / (UNIT_POWERS[exp] || 1);
    const ret = dat >= 1000 ? dat.toFixed(0) : dat.toPrecision(3);
    const unit = UNITS[exp] || 'B';

    return [ret, unit];
};

// 计算已用流量
function calculateUsedTraffic(userinfo: SubscriptionUserinfo): number {
    return userinfo.upload + userinfo.download;
}

// 计算用量信息
function formatUsageInfo(userinfo: SubscriptionUserinfo): string {
    const used = calculateUsedTraffic(userinfo);
    
    const formatBytes = (bytes: number): string => {
        const [value, unit] = parseTraffic(bytes);
        return `${value} ${unit}`;
    };
    
    let info = `${formatBytes(used)}/${formatBytes(userinfo.total)}`;
    
    if (userinfo.expire) {
        const expireDate = new Date(userinfo.expire * 1000);
        const now = new Date();
        
        if (expireDate.getTime() > now.getTime()) {
            const formattedDate = expireDate.toISOString().split('T')[0]; // YYYY-MM-DD 格式
            info += ` (${formattedDate})`;
        } else {
            info += ` (已过期)`;
        }
    }
    
    return info;
}

// 检查订阅是否有效（未过期且流量未用完）
function isValidSubscription(userinfo: SubscriptionUserinfo): boolean {
    const used = calculateUsedTraffic(userinfo);
    if (used >= userinfo.total) return false;
    
    if (!userinfo.expire) return true; // 没有 expire 值代表未过期
    const now = Math.floor(Date.now() / 1000);
    return userinfo.expire > now;
}

// 解析 YAML 内容
function parseYamlContent(body: string): boolean {
    try {
        YAML.parse(body);
        return true;
    } catch (error) {
        return false;
    }
}

// 验证订阅有效性
function validateSubscription(userinfo: SubscriptionUserinfo): { valid: boolean; reason?: string } {
    const used = calculateUsedTraffic(userinfo);
    
    if (used >= userinfo.total) {
        return { valid: false, reason: '流量已用完' };
    }
    
    if (userinfo.expire) {
        const now = Math.floor(Date.now() / 1000);
        if (userinfo.expire <= now) {
            return { valid: false, reason: '已过期' };
        }
    }
    
    return { valid: true };
}

// --- 核心功能函数 ---

/**
 * 通用Fofa API查询函数
 */
function queryFofaApiGeneric(queryString: string, description: string): Promise<FofaTarget[]> {
    logger.info(`Starting Fofa API query for ${description}...`);
    
    const queryBase64 = Buffer.from(queryString).toString("base64");
    const fofaUrl = `https://fofa.info${FOFA_SEARCH_PATH}?key=${key}&qbase64=${queryBase64}&fields=${fields}&size=${size}`;

    return fetch(fofaUrl, { tls: { rejectUnauthorized: false } })
        .then(response => {
            if (!response.ok) {
                throw new Error(`Fofa API request failed with status: ${response.status}`);
            }
            return response.json();
        })
        .then((fofaData: any) => {
            if (fofaData.error) {
                throw new Error(`Fofa API 错误: ${fofaData.errmsg}`);
            }
            if (!fofaData.results || fofaData.results.length === 0) {
                return [];
            }
            logger.success(`Fofa API query for ${description} completed.`);
            return fofaData.results.map((r: [string, string, string, string]) => ({
                host: r[0],
                protocol: r[1],
                header: r[2] || '',
                banner: r[3] || ''
            }));
        });
}

/**
 * 从Fofa获取包含订阅链接的目标主机列表
 */
function queryFofaApi(): Promise<FofaTarget[]> {
    const subscriptionTokenQuery = "/api/v1/client/subscribe?token=";
    return queryFofaApiGeneric(subscriptionTokenQuery, "subscription token search");
}

/**
 * 查询包含subscription-userinfo的主机
 */
function queryFofaApiForSubscriptionHeaders(): Promise<FofaTarget[]> {
    const subscriptionQuery = 'header="subscription-userinfo" || banner="subscription-userinfo"';
    return queryFofaApiGeneric(subscriptionQuery, "subscription-userinfo headers");
}

/**
 * 并发访问主机以获取页面内容
 */
function fetchPageContents(targets: FofaTarget[]): Promise<PageResult[]> {
    logger.info(`Fetching page content from ${targets.length} targets (Concurrency: ${CONCURRENCY_LIMIT})`);

    const progressBar = new ProgressBar(chalk.blueBright('  fetching [:bar] :current/:total :percent'), {
        complete: '=',
        incomplete: ' ',
        width: PROGRESS_BAR_WIDTH,
        total: targets.length
    });

    const promise = async.mapLimit<FofaTarget, PageResult | null>(
        targets,
        CONCURRENCY_LIMIT,
        (target, callback) => {
            const finalUrl = target.host.startsWith('http') ? target.host : `${target.protocol || 'http'}://${target.host}`;
            fetch(finalUrl, { 
                signal: AbortSignal.timeout(REQUEST_TIMEOUT), 
                tls: { rejectUnauthorized: false } 
            })
                .then(res => {
                    if (!res.ok) return null;
                    return res.text().then(body => ({ 
                        host: target.host, 
                        body, 
                        header: target.header, 
                        banner: target.banner 
                    }));
                })
                .catch(() => null)
                .then(result => {
                    progressBar.tick();
                    callback(null, result);
                });
        }
    );

    return promise.then(results => {
        const validResults = (results || []).filter(Boolean) as PageResult[];
        logger.info(`\nPage content fetched. Found ${validResults.length} valid pages.`);
        return validResults;
    });
}

/**
 * 从页面内容中提取所有潜在链接并去重
 */
function extractSubscriptionLinks(pageResults: PageResult[]): { link: Link; host: Host }[] {
    logger.info(`Processing ${pageResults.length} pages to extract subscription links...`);

    const uniquePotentialLinks = new Map<Link, Host>();

    const findAndAddLinks = (content: string, host: Host) => {
        if (!content) return;
        const matches = content.match(SUBSCRIPTION_REGEX);
        if (matches) {
            matches.forEach(link => {
                if (!uniquePotentialLinks.has(link)) {
                    uniquePotentialLinks.set(link, host);
                }
            });
        }
    };

    // 边处理边去重，优化内存使用
    pageResults.forEach(({ host, body, header, banner }) => {
        findAndAddLinks(body, host);
        findAndAddLinks(header, host);
        findAndAddLinks(banner, host);
    });

    const potentialLinksToVerify = Array.from(uniquePotentialLinks.entries()).map(([link, host]) => ({ link, host }));
    
    if (potentialLinksToVerify.length > 0) {
        logger.info(`Extracted ${potentialLinksToVerify.length} unique potential links.`);
    }
    
    return potentialLinksToVerify;
}

/**
 * 处理subscription服务主机，直接构建URL进行验证
 */
function processSubscriptionHosts(subscriptionTargets: FofaTarget[]): { link: Link; host: Host }[] {
    logger.info(`Processing ${subscriptionTargets.length} subscription service hosts...`);

    const subscriptionLinksToVerify: { link: Link; host: Host }[] = [];

    subscriptionTargets.forEach(target => {
        // 构建完整的URL，与fetchPageContents中的逻辑保持一致
        const finalUrl = target.host.startsWith('http') ? target.host : `${target.protocol || 'http'}://${target.host}`;
        
        // 这些主机本身就是订阅服务，直接作为订阅链接
        subscriptionLinksToVerify.push({
            link: finalUrl,
            host: target.host
        });
    });

    if (subscriptionLinksToVerify.length > 0) {
        logger.info(`Generated ${subscriptionLinksToVerify.length} subscription links from direct hosts.`);
    }
    
    return subscriptionLinksToVerify;
}

/**
 * 验证链接有效性
 */
function verifySubscriptionLinks(linksToVerify: { link: Link; host: Host }[]): Promise<VerificationResult[]> {
    logger.info(`Verifying ${linksToVerify.length} potential links (Concurrency: ${CONCURRENCY_LIMIT})`);

    const progressBar = new ProgressBar(chalk.blueBright('  verifying [:bar] :current/:total :percent'), {
        complete: '=',
        incomplete: ' ',
        width: PROGRESS_BAR_WIDTH,
        total: linksToVerify.length
    });

    const promise = async.mapLimit<{ link: Link; host: Host }, VerificationResult | null>(
        linksToVerify,
        CONCURRENCY_LIMIT,
        ({ link, host }, callback) => {
            fetch(link, {
                signal: AbortSignal.timeout(REQUEST_TIMEOUT),
                tls: { rejectUnauthorized: false },
                redirect: 'follow',
                headers: {
                    'User-Agent': CLASH_UA
                }
            })
                .then(res => {
                    if (!res.ok) return { link, host, status: 'failed', reason: `HTTP ${res.status}` } as VerificationResult;
                    
                    // 获取 subscription-userinfo 响应头（HTTP 头名称大小写不敏感）
                    const subscriptionUserinfo = res.headers.get('subscription-userinfo');
                    
                    // 必须包含 subscription-userinfo 信息
                    if (!subscriptionUserinfo) {
                        return { link, host, status: 'failed', reason: '缺少 subscription-userinfo 响应头' } as VerificationResult;
                    }
                    
                    const userinfo = parseSubscriptionUserinfo(subscriptionUserinfo);
                    if (!userinfo) {
                        return { link, host, status: 'failed', reason: 'subscription-userinfo 解析失败' } as VerificationResult;
                    }
                    
                    return res.text().then(subBody => {
                        const body = subBody || '';
                        
                        // 解析 YAML 内容
                        if (!parseYamlContent(body)) {
                            return { link, host, status: 'failed', reason: '非 YAML 内容' } as VerificationResult;
                        }
                        
                        // 验证订阅有效性
                        const validation = validateSubscription(userinfo);
                        if (!validation.valid) {
                            return { link, host, status: 'failed', reason: validation.reason } as VerificationResult;
                        }
                        
                        // 构建成功结果
                        return { 
                            link, 
                            host, 
                            status: 'success', 
                            reason: formatUsageInfo(userinfo) 
                        } as VerificationResult;
                    });
                })
                .catch((err: any) => ({ link, host, status: 'failed', reason: `访问失败 (${err.message})` } as VerificationResult))
                .then(result => {
                    progressBar.tick();
                    callback(null, result);
                });
        }
    );

    return promise.then(results => {
        logger.info("\nLink verification completed.");
        return (results || []).filter(Boolean) as VerificationResult[];
    });
}

/**
 * 报告结果
 */
function reportResults(results: VerificationResult[]) {
    logger.info("Reporting results...");

    const successfulLinks = results.filter(r => r.status === 'success');

    if (successfulLinks.length > 0) {
        logger.success(`\n[+] 发现 ${successfulLinks.length} 个有效的订阅链接:`);
        successfulLinks.forEach(r => {
            // 构建完整的来源URL，与fetchPageContents中的逻辑保持一致
            const sourceUrl = r.host.startsWith('http') ? r.host : `http://${r.host}`;
            console.log(`  - ${r.link} (来源: ${sourceUrl})`);
            if (r.reason) {
                logger.cyan(`    用量信息: ${r.reason}`);
            }
        });
    }

    logger.info("----------------------------------------");
    if (successfulLinks.length === 0) {
        console.log("Task completed. No valid subscription links found.");
    } else {
        console.log(`Task completed! Found ${successfulLinks.length} valid subscription links.`);
    }
    logger.info("----------------------------------------");
}


// --- 主函数 ---
async function main() {
    say('F-Proxy', {
        font: 'block',
        align: 'left',
        gradient: ['#39ff14', '#00f2ff'],
        independentGradient: true,
        env: 'node'
    });

    try {
        // 第1步: 查询包含订阅链接的页面
        logger.step(1, 6, "Querying Fofa for pages containing subscription links");
        const fofaTargets = await queryFofaApi();
        if (fofaTargets.length === 0) {
            logger.warning("Fofa API returned no results for the given query.");
            return;
        }
        logger.success("--- Step 1/6 Completed ---");

        // 第2步: 查询包含subscription-userinfo的主机
        logger.step(2, 6, "Querying Fofa for subscription service hosts");
        const subscriptionTargets = await queryFofaApiForSubscriptionHeaders();
        logger.success("--- Step 2/6 Completed ---");

        // 第3步: 获取页面内容
        logger.step(3, 6, "Fetching page contents");
        const pageResults = await fetchPageContents(fofaTargets);
        if (pageResults.length === 0) {
            logger.warning("No pages could be fetched or processed.");
            return;
        }
        logger.success("--- Step 3/6 Completed ---");

        // 第4步: 提取订阅链接
        logger.step(4, 6, "Extracting subscription links");
        const potentialLinksToVerify = extractSubscriptionLinks(pageResults);
        const subscriptionLinksToVerify = processSubscriptionHosts(subscriptionTargets);
        
        // 合并两种来源的链接并去重
        const combinedLinks = [...potentialLinksToVerify, ...subscriptionLinksToVerify];
        const uniqueLinksMap = new Map<string, { link: string; host: string }>();
        
        // 去重，保留第一次出现的链接
        combinedLinks.forEach(item => {
            if (!uniqueLinksMap.has(item.link)) {
                uniqueLinksMap.set(item.link, item);
            }
        });
        
        const allLinksToVerify = Array.from(uniqueLinksMap.values());
        const duplicateCount = combinedLinks.length - allLinksToVerify.length;
        
        if (allLinksToVerify.length === 0) {
            logger.info("----------------------------------------");
            logger.warning("No potential subscription links found from any source.");
            return;
        }
        
        logger.info(`Total links before deduplication: ${combinedLinks.length} (${potentialLinksToVerify.length} from body extraction + ${subscriptionLinksToVerify.length} from direct subscription hosts)`);
        if (duplicateCount > 0) {
            logger.info(`Removed ${duplicateCount} duplicate links`);
        }
        logger.info(`Final links to verify: ${allLinksToVerify.length}`);
        logger.success("--- Step 4/6 Completed ---");

        // 第5步: 验证链接有效性
        logger.step(5, 6, "Verifying subscription links");
        const verificationResults = await verifySubscriptionLinks(allLinksToVerify);
        logger.success("--- Step 5/6 Completed ---");

        // 第6步: 报告结果
        logger.step(6, 6, "Reporting results");
        reportResults(verificationResults);
        logger.success("--- Step 6/6 Completed ---");

    } catch (error: any) {
        logger.error(`\n处理过程中发生严重错误: ${error.message}`);
        exit(1);
    }
}

main();