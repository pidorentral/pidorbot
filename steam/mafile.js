// const code = SteamTotp.generateAuthCode("sharedSecret");

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

    const steamId = mafile.steamid ?? mafile.steam_id ?? mafile.Session?.SteamID ?? mafile.session?.SteamID ?? null;

    return {
        sharedSecret: mafile.shared_secret,
        identitySecret: mafile.identity_secret ?? null,
        steamId: steamId == null ? null : String(steamId),
        accountName: mafile.account_name ?? null,
        raw: mafile,
    };
}