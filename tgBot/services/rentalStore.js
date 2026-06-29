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

export function getActiveRentals() {
  return rentals.filter((rental) => rental.status === 'active');
}

export function getOrders() {
  return [...orders];
}

export function addAccount({ title, login, password }) {
  const account = {
    id: accounts.length + 1,
    title,
    login,
    password,
    status: 'available',
    createdAt: new Date().toISOString(),
  };

  accounts.push(account);
  return account;
}
