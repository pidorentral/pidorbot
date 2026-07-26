import dotenv from 'dotenv';
import { handleNewOrders } from '../src/funpay/handlers/orderHandler.js';

const mockClient = {
  getChatNodeId: async () => 12345,
  sendMessage: async (nodeId, text) => { console.log(`→ [${nodeId}]`, text); },
};

const fakeOrder = {
  funpayOrderId: 'TEST-001',
  buyer: 'TestBuyer',
  price: 100,
  lotId: '123456',
};

await handleNewOrders([fakeOrder], console, {
  client: mockClient,
  notifyAdmin: async (msg) => console.log('ADMIN:', msg),
});