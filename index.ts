
import { exit } from "process";
import async from "async";
import { Buffer } from "buffer";
import chalk from 'chalk';
import ProgressBar from 'progress';

// --- 配置 ---
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT || '5', 10); // 并发请求数，默认为5

// --- Fofa API 配置 ---
const key = process.env.FOFA_KEY;
const query = `body="/api/v1/client/subscribe?token="`;
const fields = "host,protocol";
const size = parseInt(process.env.FOFA_SIZE || '20', 10);

// --- 检查和准备 ---
if (!key) {
  console.error("错误：请在 .env 文件中设置您的 FOFA_KEY。");
  console.log("您可以从 https://fofa.info/userInfo 获取您的key");
  exit(1);
}

const query_qbase64 = Buffer.from(query).toString("base64");
const fofaUrl = `https://fofa.info/api/v1/search/all?key=${key}&qbase64=${query_qbase64}&size=${size}&fields=${fields}`;
const subscriptionRegex = /(https?:\/\/[^\s\"\'<>`]+\/api\/v1\/client\/subscribe\?token=[a-zA-Z0-9]+)/g;

// --- 类型定义 ---
type Host = string;
type Link = string;
interface PageResult {
    host: Host;
    body: string;
}
type VerificationResult = {
    link: Link;
    host: Host;
    status: 'success' | 'failed';
    reason?: string;
};

// --- 主函数 ---
async function main() {
    try {
        // 第1步: 从Fofa获取目标主机列表
        console.log(chalk.white(`
--- Step 1/5: Querying Fofa API ---`));
        console.log(chalk.yellow("Starting Fofa API query..."));
        const fofaResponse = await fetch(fofaUrl);
        if (!fofaResponse.ok) throw new Error(`Fofa API 请求失败: ${fofaResponse.status}`);
        const fofaData: any = await fofaResponse.json();
        if (fofaData.error) throw new Error(`Fofa API 错误: ${fofaData.errmsg}`);
        if (!fofaData.results || fofaData.results.length === 0) {
            console.log("Fofa API returned no results for the given query.");
            return;
        }
        console.log(chalk.green("Fofa API query completed."));
        console.log(chalk.green("--- Step 1/5 Completed ---"));

        const fofaTargets: { host: string, protocol: string }[] = fofaData.results.map((r: [string, string]) => ({
            host: r[0],
            protocol: r[1]
        }));

        console.log(chalk.white(`
--- Step 2/5: Fetching page content from ${fofaTargets.length} targets (Concurrency: ${CONCURRENCY_LIMIT}) ---`));
        console.log(chalk.magenta(`Fofa returned ${fofaTargets.length} targets.`));
        

        // 第2步: 并发访问主机以获取页面内容
        const pageProgressBar = new ProgressBar(chalk.blueBright('  fetching [:bar] :current/:total :percent'), {
            complete: '=',
            incomplete: ' ',
            width: 20,
            total: fofaTargets.length
        });

        const pageResults = await async.mapLimit<typeof fofaTargets[0], PageResult | null>(
            fofaTargets,
            CONCURRENCY_LIMIT,
            async (target) => {
                const finalUrl = target.host.startsWith('http') ? target.host : `${target.protocol || 'http'}://${target.host}`;
                try {
                    const res = await fetch(finalUrl, { signal: AbortSignal.timeout(5000) });
                    if (!res.ok) return null;
                    const body = await res.text();
                    return { host: target.host, body };
                } catch {
                    return null;
                } finally {
                    pageProgressBar.tick();
                }
            }
        );
        pageProgressBar.terminate();

        const validPageResults = pageResults.filter(Boolean) as PageResult[];
        console.log(chalk.magenta(`Page content fetched. Found ${validPageResults.length} valid pages.`));
        console.log(chalk.green("--- Step 2/5 Completed ---"));
        console.log(chalk.white(`
--- Step 3/5: Extracting and deduplicating potential subscription links ---
`));
        console.log(chalk.magenta(`Processing ${validPageResults.length} pages...`));

        // 第3步 (a): 从页面内容中提取所有潜在链接并去重
        const uniquePotentialLinks = new Map<Link, Host>(); // 使用Map来去重并保留host信息
        validPageResults.forEach(({ host, body }) => {
            const matches = body.match(subscriptionRegex);
            if (matches) {
                matches.forEach(link => {
                    if (!uniquePotentialLinks.has(link)) {
                        uniquePotentialLinks.set(link, host);
                    }
                });
            }
        });

        const potentialLinksToVerify: { link: Link; host: Host }[] = Array.from(uniquePotentialLinks.entries()).map(([link, host]) => ({ link, host }));

        if (potentialLinksToVerify.length === 0) {
            console.log(chalk.magenta("----------------------------------------"));
            console.log("No potential subscription links extracted from pages.");
            return;
        }

        console.log(chalk.magenta(`Extracted ${potentialLinksToVerify.length} unique potential links.`));
        console.log(chalk.green("--- Step 3/5 Completed ---"));
        console.log(chalk.white(`
--- Step 4/5: Verifying ${potentialLinksToVerify.length} potential links (Concurrency: ${CONCURRENCY_LIMIT}) ---
`));

        const verificationProgressBar = new ProgressBar(chalk.blueBright('  verifying [:bar] :current/:total :percent'), {
            complete: '=',
            incomplete: ' ',
            width: 20,
            total: potentialLinksToVerify.length
        });

        const verificationResults = await async.mapLimit<typeof potentialLinksToVerify[0], VerificationResult>(
            potentialLinksToVerify,
            CONCURRENCY_LIMIT,
            async ({ link, host }) => {
                try {
                    const res = await fetch(link, { signal: AbortSignal.timeout(5000) });
                    if (!res.ok) return { link, host, status: 'failed', reason: `HTTP ${res.status}` };
                    const subBody = await res.text();
                    if (subBody.toLowerCase().includes('token')) {
                        return { link, host, status: 'failed', reason: '响应包含 "token" 错误' };
                    }
                    const isBase64 = Buffer.from(subBody, 'base64').toString('base64') === subBody && subBody.trim().length > 0;
                    if (isBase64) {
                        return { link, host, status: 'success' };
                    } else {
                        return { link, host, status: 'failed', reason: '响应不是有效的Base64' };
                    }
                } catch (err: any) {
                    return { link, host, status: 'failed', reason: `访问失败 (${err.message})` };
                } finally {
                    verificationProgressBar.tick();
                }
            }
        );
        verificationProgressBar.terminate();
        console.log(chalk.magenta("Link verification completed."));
        console.log(chalk.green("--- Step 4/5 Completed ---"));

        // 第4步: 报告结果
        console.log(chalk.white(`
--- Step 5/5: Reporting Results ---
`));
        console.log(chalk.magenta("Reporting results..."));

        const successfulLinks = verificationResults.filter(r => r.status === 'success');
        const failedLinks = verificationResults.filter(r => r.status === 'failed');

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

    } catch (error: any) {
        console.error(chalk.red(`\n处理过程中发生严重错误: ${error.message}`));
        exit(1);
    }
}

main();
