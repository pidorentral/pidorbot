const accounts = [];
const orders = [];
const rentals = [];

export function getStats() {
  const availableAccounts = accounts.filter((account) => account.status === 'available').length;
  const rentedAccounts = accounts.filter((account) => account.status === 'rented').length;
  const activeRentals = rentals.filter((rental) => rental.status === 'active').length;

  return {
    totalAccounts: accounts.length,
    availableAccounts,
    rentedAccounts,
    activeRentals,
    totalOrders: orders.length,
  };
}

export function getAccounts() {
  return [...accounts];
}

export function getAccountById(id) {
  return accounts.find((account) => account.id === id);
}

export function getActiveRentals() {
  return rentals.filter((rental) => rental.status === 'active');
}

export function getOrders() {
  return [...orders];
}

export function addAccount({ 
  title,
  login, 
  password,
  sharedSecret = null,
  identitySecret = null,
  steamId = null,
  accountName = null,
   }) {
    const account = {
      id: accounts.length + 1,
      title,
      login,
      password,
      sharedSecret,
      identitySecret,
      steamId,
      accountName,
      status: 'available',
      createdAt: new Date().toISOString(),
    };

    accounts.push(account);
    return account;
}

export function attachMafileToAccount(id, mafileData) {
  const account = getAccountById(id);

  if(!account) {
    return null;
  }

  account.sharedSecret = mafileData.sharedSecret;
  account.identitySecret = mafileData.identitySecret;
  account.steamId = mafileData.steamId;
  account.accountName = mafileData.accountName;

  return account;
}
