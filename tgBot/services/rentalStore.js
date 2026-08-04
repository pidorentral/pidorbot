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
  completeRental,
  cancelRental,
  setAccountStatus,
  deleteAccount,
  updateAccount,
};
