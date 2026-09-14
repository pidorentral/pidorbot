/**
 * Extract fresh Steam cookies via manual browser login
 * Run interactively to refresh authentication cookies
 * Usage: node steam/extractCookies.js
 */
import { chromium } from 'playwright';
import readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function question(prompt) {
    return new Promise(resolve => rl.question(prompt, resolve));
}

async function extractCookies() {
    console.log('🔐 Steam Cookie Extraction Tool');
    console.log('================================\n');
    console.log('This will open a headed Chromium browser.');
    console.log('Log in to Steam, complete any 2FA/CAPTCHA, and navigate to:');
    console.log('  https://store.steampowered.com/twofactor/manage\n');
    console.log('Once you see the device management page, press Enter in this terminal.\n');

    await question('Press Enter to start...');

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('https://store.steampowered.com/login/', {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
    });

    console.log('\n✓ Browser opened. Log in on the browser window...\n');

    // Wait for user to manually navigate to /twofactor/manage
    await question('After logging in and reaching the device management page, press Enter here...');

    // Extract all cookies
    const cookies = await context.cookies();

    console.log('\n📋 Extracted cookies:\n');
    const cookieObj = {};
    for (const cookie of cookies) {
        if (cookie.domain && cookie.domain.includes('steam')) {
            cookieObj[cookie.name] = cookie.value;
            console.log(`${cookie.name}: ${cookie.value.substring(0, 30)}... (len: ${cookie.value.length})`);
        }
    }

    console.log('\n\n🔑 Full cookie JSON for database:\n');
    console.log(JSON.stringify(cookieObj, null, 2));

    console.log('\n\n📝 SQL INSERT example:');
    console.log(`UPDATE accounts SET cookies = '${JSON.stringify(cookieObj)}' WHERE login = 'YOUR_LOGIN';`);

    await browser.close();
    rl.close();
}

extractCookies().catch(err => {
    console.error('Error:', err);
    rl.close();
    process.exit(1);
});
