import SteamTotp from 'steam-totp';

export function generateSteamGuardCode(sharedSecret) {
    if (!sharedSecret) {
        throw new Error('sharedSecret is required.');
    }

    return SteamTotp.generateAuthCode(sharedSecret);
}