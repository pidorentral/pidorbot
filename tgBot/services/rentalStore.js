import * as readDao from '../../src/dao/read.js';
import * as writeDao from '../../src/dao/write.js';

export async function getStats() {
  return readDao.getStats();
}

export async function getAccounts(opts = {}) {
  return readDao.listAccounts(opts);
}

export async function getAccountById(id, opts = {}) {
  return readDao.getAccountById(id, opts);
}

export async function getActiveRentals() {
  return readDao.getActiveRentals();
}

export async function getOrders(opts = {}) {
  return readDao.getOrders(opts);
}

export async function addAccount(payload) {
  return writeDao.addAccount(payload);
}

export async function attachMafileToAccount(accountId, mafile) {
  return writeDao.attachMafileToAccount(accountId, mafile);
}

export async function createOrder(payload) {
  return writeDao.createOrder(payload);
}

export async function reserveAccount(payload) {
  return writeDao.reserveAccount(payload);
}

export async function completeRental(rentalId) {
  return writeDao.completeRental(rentalId);
}

export async function cancelRental(rentalId) {
  return writeDao.cancelRental(rentalId);
}

// Account management helpers
export async function setAccountStatus(accountId, status) {
  return writeDao.setAccountStatus(accountId, status);
}

export async function deleteAccount(accountId) {
  return writeDao.deleteAccount(accountId);
}

export async function updateAccount(accountId, updates) {
  return writeDao.updateAccount(accountId, updates);
}

export default {
  getStats,
  getAccounts,
  getAccountById,
  getActiveRentals,
  getOrders,
  addAccount,
  attachMafileToAccount,
  createOrder,
  reserveAccount,
  completeRental,
  cancelRental,
  setAccountStatus,
  deleteAccount,
  updateAccount,
};
const accounts = [];
const orders = [];
const rentals = [];

// export function getStats() {
//   const availableAccounts = accounts.filter((account) => account.status === 'available').length;
//   const rentedAccounts = accounts.filter((account) => account.status === 'rented').length;
//   const activeRentals = rentals.filter((rental) => rental.status === 'active').length;

//   return {
//     totalAccounts: accounts.length,
//     availableAccounts,
//     rentedAccounts,
//     activeRentals,
//     totalOrders: orders.length,
//   };
// }

// export function getAccounts() {
//   return [...accounts];
// }

// export function getAccountById(id) {
//   return accounts.find((account) => account.id === id);
// }

// export function getActiveRentals() {
//   return rentals.filter((rental) => rental.status === 'active');
// }

// export function getOrders() {
//   return [...orders];
// }

// export function addAccount({ 
//   title,
//   login, 
//   password,
//   sharedSecret = null,
//   identitySecret = null,
//   steamId = null,
//   accountName = null,
//    }) {
//     const account = {
//       id: accounts.length + 1,
//       title,
//       login,
//       password,
//       sharedSecret,
//       identitySecret,
//       steamId,
//       accountName,
//       status: 'available',
//       createdAt: new Date().toISOString(),
//     };

//     accounts.push(account);
//     return account;
// }

// export function attachMafileToAccount(id, mafileData) {
//   const account = getAccountById(id);

//   if(!account) {
//     return null;
//   }

//   account.sharedSecret = mafileData.sharedSecret;
//   account.identitySecret = mafileData.identitySecret;
//   account.steamId = mafileData.steamId;
//   account.accountName = mafileData.accountName;

//   return account;
// }