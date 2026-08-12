// const code = SteamTotp.generateAuthCode("sharedSecret");

function normalizeSteamId(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const raw = String(value).trim();
    if (!/^\d+$/.test(raw)) {
        return null;
    }

    const numeric = BigInt(raw);
    const candidate = numeric - 8n;
    const minimumSteamId = 76561197960265728n;

    if (
        numeric >= minimumSteamId &&
        numeric % 10n === 0n &&
        candidate >= minimumSteamId &&
        candidate % 10n === 2n
    ) {
        return candidate.toString();
    }

    return numeric.toString();
}

export function parseMafile(rawText) {
    let mafile;

    try {
        mafile = JSON.parse(rawText);
    } catch {
        throw new Error('Invalid mafile JSON')
    }

    if(!mafile.shared_secret) {
        throw new Error('shared_secret is missing')
    }

    const steamId = normalizeSteamId(mafile.steamid ?? mafile.steam_id ?? mafile.Session?.SteamID ?? mafile.session?.SteamID ?? null);

    return {
        sharedSecret: mafile.shared_secret,
        identitySecret: mafile.identity_secret ?? null,
        steamId: steamId == null ? null : String(steamId),
        accountName: mafile.account_name ?? null,
        raw: mafile,
    };
}