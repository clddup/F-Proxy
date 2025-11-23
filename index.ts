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

interface FofaResponse {
    error?: boolean;
    errmsg?: string;
    results?: [string, string, string, string][];
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

interface VerificationResult {
    link: Link;
    host: Host;
    status: 'success' | 'failed';
    usageInfo?: string;    // 成功时的用量信息
    failReason?: string;   // 失败时的原因
}

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

// 构建完整 URL（消除重复代码）
function buildFullUrl(host: string, protocol?: string): string {
    return host.startsWith('http') ? host : `${protocol || 'http'}://${host}`;
}

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

// 解析 YAML 内容并验证是否为有效的Clash配置
function parseYamlContent(body: string): boolean {
    try {
        const parsed = YAML.parse(body);
        
        // 检查是否为有效的Clash配置格式
        if (!parsed || typeof parsed !== 'object') {
            return false;
        }
        
        // 必须包含proxy-groups属性（Clash配置的核心）
        if (!parsed['proxy-groups'] || !Array.isArray(parsed['proxy-groups'])) {
            return false;
        }
        
        // proxy-groups数组不能为空
        if (parsed['proxy-groups'].length === 0) {
            return false;
        }
        
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
            return response.json() as Promise<FofaResponse>;
        })
        .then((fofaData) => {
            if (fofaData.error) {
                throw new Error(`Fofa API 错误: ${fofaData.errmsg}`);
            }
            if (!fofaData.results || fofaData.results.length === 0) {
                return [];
            }
            logger.success(`Fofa API query for ${description} completed.`);
            return fofaData.results.map((r) => ({
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
            const finalUrl = buildFullUrl(target.host, target.protocol);
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
        // 这些主机本身就是订阅服务，直接作为订阅链接
        subscriptionLinksToVerify.push({
            link: buildFullUrl(target.host, target.protocol),
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
                    if (!res.ok) return { link, host, status: 'failed', failReason: `HTTP ${res.status}` } as VerificationResult;

                    // 获取 subscription-userinfo 响应头（HTTP 头名称大小写不敏感）
                    const subscriptionUserinfo = res.headers.get('subscription-userinfo');

                    // 必须包含 subscription-userinfo 信息
                    if (!subscriptionUserinfo) {
                        return { link, host, status: 'failed', failReason: '缺少 subscription-userinfo 响应头' } as VerificationResult;
                    }

                    const userinfo = parseSubscriptionUserinfo(subscriptionUserinfo);
                    if (!userinfo) {
                        return { link, host, status: 'failed', failReason: 'subscription-userinfo 解析失败' } as VerificationResult;
                    }

                    return res.text().then(subBody => {
                        const body = subBody || '';

                        // 解析 YAML 内容
                        if (!parseYamlContent(body)) {
                            return { link, host, status: 'failed', failReason: '非 YAML 内容' } as VerificationResult;
                        }

                        // 验证订阅有效性
                        const validation = validateSubscription(userinfo);
                        if (!validation.valid) {
                            return { link, host, status: 'failed', failReason: validation.reason } as VerificationResult;
                        }

                        // 构建成功结果
                        return {
                            link,
                            host,
                            status: 'success',
                            usageInfo: formatUsageInfo(userinfo)
                        } as VerificationResult;
                    });
                })
                .catch((err: any) => ({ link, host, status: 'failed', failReason: `访问失败 (${err.message})` } as VerificationResult))
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
            const sourceUrl = buildFullUrl(r.host);
            console.log(`  - ${r.link} (来源: ${sourceUrl})`);
            if (r.usageInfo) {
                logger.cyan(`    用量信息: ${r.usageInfo}`);
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


/**
 * 去重链接，优先保留 HTTPS 版本
 */
function deduplicateLinks(links: { link: Link; host: Host }[]): { link: Link; host: Host }[] {
    const uniqueLinksMap = new Map<string, { link: Link; host: Host }>();

    links.forEach(item => {
        try {
            const url = new URL(item.link);
            const hostKey = url.hostname + url.pathname + url.search;

            const existing = uniqueLinksMap.get(hostKey);
            if (!existing) {
                uniqueLinksMap.set(hostKey, item);
            } else if (item.link.startsWith('https://') && existing.link.startsWith('http://')) {
                // 优先保留 HTTPS 版本
                uniqueLinksMap.set(hostKey, item);
            }
        } catch {
            // URL 解析失败时使用原始链接作为键
            if (!uniqueLinksMap.has(item.link)) {
                uniqueLinksMap.set(item.link, item);
            }
        }
    });

    return Array.from(uniqueLinksMap.values());
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
        // 第1步: 并行查询 Fofa（性能优化）
        logger.step(1, 5, "Querying Fofa API (parallel)");
        logger.info("Querying for subscription links and subscription-userinfo headers in parallel...");

        const [fofaTargets, subscriptionTargets] = await Promise.all([
            queryFofaApi(),
            queryFofaApiForSubscriptionHeaders()
        ]);

        logger.info(`Found ${fofaTargets.length} targets with subscription links`);
        logger.info(`Found ${subscriptionTargets.length} targets with subscription-userinfo headers`);

        if (fofaTargets.length === 0 && subscriptionTargets.length === 0) {
            logger.warning("Fofa API returned no results for both queries.");
            return;
        }
        logger.success("--- Step 1/5 Completed ---");

        // 第2步: 获取页面内容
        logger.step(2, 5, "Fetching page contents");
        const pageResults = fofaTargets.length > 0 ? await fetchPageContents(fofaTargets) : [];
        if (pageResults.length === 0 && subscriptionTargets.length === 0) {
            logger.warning("No pages could be fetched and no direct subscription hosts found.");
            return;
        }
        logger.success("--- Step 2/5 Completed ---");

        // 第3步: 提取并去重订阅链接
        logger.step(3, 5, "Extracting and deduplicating subscription links");
        const potentialLinksToVerify = extractSubscriptionLinks(pageResults);
        const subscriptionLinksToVerify = processSubscriptionHosts(subscriptionTargets);

        // 合并并去重
        const combinedLinks = [...potentialLinksToVerify, ...subscriptionLinksToVerify];
        const allLinksToVerify = deduplicateLinks(combinedLinks);
        const duplicateCount = combinedLinks.length - allLinksToVerify.length;

        if (allLinksToVerify.length === 0) {
            logger.info("----------------------------------------");
            logger.warning("No potential subscription links found from any source.");
            return;
        }

        logger.info(`Total links before deduplication: ${combinedLinks.length} (${potentialLinksToVerify.length} from body + ${subscriptionLinksToVerify.length} from direct hosts)`);
        if (duplicateCount > 0) {
            logger.info(`Removed ${duplicateCount} duplicate links`);
        }
        logger.info(`Final links to verify: ${allLinksToVerify.length}`);
        logger.success("--- Step 3/5 Completed ---");

        // 第4步: 验证链接有效性
        logger.step(4, 5, "Verifying subscription links");
        const verificationResults = await verifySubscriptionLinks(allLinksToVerify);
        logger.success("--- Step 4/5 Completed ---");

        // 第5步: 报告结果
        logger.step(5, 5, "Reporting results");
        reportResults(verificationResults);
        logger.success("--- Step 5/5 Completed ---");

    } catch (error: any) {
        logger.error(`\n处理过程中发生严重错误: ${error.message}`);
        exit(1);
    }
}

main();