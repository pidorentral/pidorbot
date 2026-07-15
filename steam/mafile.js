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

    return {
        sharedSecret: mafile.shared_secret,
        identitySecret: mafile.identity_secret ?? null,
        steamId: mafile.steamid ?? null,
        accountName: mafile.account_name ?? null,
        raw: mafile,
    };
}