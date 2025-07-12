import { exit } from "process";
import async from "async";
import { Buffer } from "buffer";
import chalk from 'chalk';
import ProgressBar from 'progress';
import { say } from 'cfonts';

// --- 配置 ---
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT || '5', 10); // 并发请求数，默认为5

// --- Fofa API 配置 ---
const key = process.env.FOFA_KEY;
const query = "/api/v1/client/subscribe?token=";
const fields = "host,protocol,header,banner";
const size = parseInt(process.env.FOFA_SIZE || '20', 10);

// --- 检查和准备 ---
if (!key) {
    console.error(chalk.red("错误：请在 .env 文件中设置您的 FOFA_KEY。"));
    console.log("您可以从 https://fofa.info/userInfo 获取您的key");
    exit(1);
}

const query_qbase64 = Buffer.from(query).toString("base64");
const FOFA_SEARCH_PATH = "/api/v1/search/all";
const subscriptionRegex = /(https?:\/\/[^\s\"\'<>`]+\/api\/v1\/client\/subscribe\?token=[a-zA-Z0-9]+)/g;

// --- 类型定义 ---
type Host = string;
type Link = string;
interface FofaTarget {
    host: string;
    protocol: string;
    header?: string;
    banner?: string;
}
interface PageResult {
    host: Host;
    body: string;
    header?: string;
    banner?: string;
}
type VerificationResult = {
    link: Link;
    host: Host;
    status: 'success' | 'failed';
    reason?: string;
};

// --- 核心功能函数 ---

/**
 * 第1步: 从Fofa获取目标主机列表
 */
function queryFofaApi(): Promise<FofaTarget[]> {
    console.log(chalk.white(`\n--- Step 1/5: Querying Fofa API ---`));
    console.log(chalk.yellow("Starting Fofa API query..."));
    const fofaUrl = `https://fofa.info${FOFA_SEARCH_PATH}?key=${key}&qbase64=${query_qbase64}&fields=${fields}&size=${size}`;

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
            console.log(chalk.green("Fofa API query completed."));
            console.log(chalk.green("--- Step 1/5 Completed ---"));
            return fofaData.results.map((r: [string, string, string?, string?]) => ({
                host: r[0],
                protocol: r[1],
                header: r[2],
                banner: r[3]
            }));
        });
}

/**
 * 第2步: 并发访问主机以获取页面内容
 */
function fetchPageContents(targets: FofaTarget[]): Promise<PageResult[]> {
    console.log(chalk.white(`\n--- Step 2/5: Fetching page content from ${targets.length} targets (Concurrency: ${CONCURRENCY_LIMIT}) ---`));
    console.log(chalk.magenta(`Fofa returned ${targets.length} targets.`));

    const progressBar = new ProgressBar(chalk.blueBright('  fetching [:bar] :current/:total :percent'), {
        complete: '=',
        incomplete: ' ',
        width: 20,
        total: targets.length
    });

    const promise = async.mapLimit<FofaTarget, PageResult | null>(
        targets,
        CONCURRENCY_LIMIT,
        (target, callback) => {
            const finalUrl = target.host.startsWith('http') ? target.host : `${target.protocol || 'http'}://${target.host}`;
            fetch(finalUrl, { signal: AbortSignal.timeout(5000), tls: { rejectUnauthorized: false } })
                .then(res => {
                    if (!res.ok) return null;
                    return res.text().then(body => ({ host: target.host, body, header: target.header, banner: target.banner }));
                })
                .then(result => callback(null, result))
                .catch(() => callback(null, null))
                .finally(() => progressBar.tick());
        }
    );

    return promise.then(results => {
        progressBar.terminate();
        const validResults = results.filter(Boolean) as PageResult[];
        console.log(chalk.magenta(`Page content fetched. Found ${validResults.length} valid pages.`));
        console.log(chalk.green("--- Step 2/5 Completed ---"));
        return validResults;
    });
}

/**
 * 第3步: 从页面内容中提取所有潜在链接并去重
 */
function extractSubscriptionLinks(pageResults: PageResult[]): { link: Link; host: Host }[] {
    console.log(chalk.white(`\n--- Step 3/5: Extracting and deduplicating potential subscription links ---`));
    console.log(chalk.magenta(`Processing ${pageResults.length} pages...`));

    const uniquePotentialLinks = new Map<Link, Host>();

    const findAndAddLinks = (content: string | undefined, host: Host) => {
        if (!content) return;
        const matches = content.match(subscriptionRegex);
        if (matches) {
            matches.forEach(link => {
                if (!uniquePotentialLinks.has(link)) {
                    uniquePotentialLinks.set(link, host);
                }
            });
        }
    };

    pageResults.forEach(({ host, body, header, banner }) => {
        findAndAddLinks(body, host);
        findAndAddLinks(header, host);
        findAndAddLinks(banner, host);
    });

    const potentialLinksToVerify = Array.from(uniquePotentialLinks.entries()).map(([link, host]) => ({ link, host }));
    
    if (potentialLinksToVerify.length > 0) {
        console.log(chalk.magenta(`Extracted ${potentialLinksToVerify.length} unique potential links.`));
    }
    
    console.log(chalk.green("--- Step 3/5 Completed ---"));
    return potentialLinksToVerify;
}

/**
 * 第4步: 验证链接有效性
 */
function verifySubscriptionLinks(linksToVerify: { link: Link; host: Host }[]): Promise<VerificationResult[]> {
    console.log(chalk.white(`\n--- Step 4/5: Verifying ${linksToVerify.length} potential links (Concurrency: ${CONCURRENCY_LIMIT}) ---`));

    const progressBar = new ProgressBar(chalk.blueBright('  verifying [:bar] :current/:total :percent'), {
        complete: '=',
        incomplete: ' ',
        width: 20,
        total: linksToVerify.length
    });

    const promise = async.mapLimit<{ link: Link; host: Host }, VerificationResult>(
        linksToVerify,
        CONCURRENCY_LIMIT,
        ({ link, host }, callback) => {
            fetch(link, { signal: AbortSignal.timeout(5000), tls: { rejectUnauthorized: false } })
                .then(res => {
                    if (!res.ok) return { link, host, status: 'failed', reason: `HTTP ${res.status}` } as VerificationResult;
                    return res.text().then(subBody => {
                        if (subBody.toLowerCase().includes('token')) {
                            return { link, host, status: 'failed', reason: '响应包含 "token" 错误' };
                        }
                        const isBase64 = Buffer.from(subBody, 'base64').toString('base64') === subBody && subBody.trim().length > 0;
                        return isBase64
                            ? { link, host, status: 'success' }
                            : { link, host, status: 'failed', reason: '响应不是有效的Base64' };
                    });
                })
                .then(result => callback(null, result))
                .catch((err: any) => callback(null, { link, host, status: 'failed', reason: `访问失败 (${err.message})` }))
                .finally(() => progressBar.tick());
        }
    );

    return promise.then(results => {
        progressBar.terminate();
        console.log(chalk.magenta("Link verification completed."));
        console.log(chalk.green("--- Step 4/5 Completed ---"));
        return results;
    });
}

/**
 * 第5步: 报告结果
 */
function reportResults(results: VerificationResult[]) {
    console.log(chalk.white(`\n--- Step 5/5: Reporting Results ---`));
    console.log(chalk.magenta("Reporting results..."));

    const successfulLinks = results.filter(r => r.status === 'success');

    if (successfulLinks.length > 0) {
        console.log(chalk.green(`\n[+] 发现 ${successfulLinks.length} 个有效的订阅链接:`));
        successfulLinks.forEach(r => console.log(`  - ${r.link} (来源: ${r.host})`));
    }

    console.log(chalk.magenta("----------------------------------------"));
    if (successfulLinks.length === 0) {
        console.log("Task completed. No valid subscription links found.");
    } else {
        console.log(`Task completed! Found ${successfulLinks.length} valid subscription links.`);
    }
    console.log(chalk.magenta("----------------------------------------"));
}


// --- 主函数 ---
async function main() {
    say('FProxy', {
        font: 'block',
        align: 'left',
        gradient: ['#39ff14', '#00f2ff'],
        independentGradient: true,
        env: 'node'
    });

    try {
        const fofaTargets = await queryFofaApi();
        if (fofaTargets.length === 0) {
            console.log("Fofa API returned no results for the given query.");
            return;
        }

        const pageResults = await fetchPageContents(fofaTargets);
        if (pageResults.length === 0) {
            console.log("No pages could be fetched or processed.");
            return;
        }

        const potentialLinksToVerify = extractSubscriptionLinks(pageResults);
        if (potentialLinksToVerify.length === 0) {
            console.log(chalk.magenta("----------------------------------------"));
            console.log("No potential subscription links extracted from pages.");
            return;
        }

        const verificationResults = await verifySubscriptionLinks(potentialLinksToVerify);

        reportResults(verificationResults);

    } catch (error: any) {
        console.error(chalk.red(`\n处理过程中发生严重错误: ${error.message}`));
        exit(1);
    }
}

main();