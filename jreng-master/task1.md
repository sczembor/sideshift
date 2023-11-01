`confirm-native-extra.ts` contains a worker that checks specific Ethereum deposit addresses for missed deposits. In the rare event that user deposits are not automatically detected, admins can queue an order for scanning. 

These `orderId`s are added to a Redis messaging queue through GraphQL and this worker watches these messages, see `const queue = await RedisTaskQueue.queues.evmNativeConfirm(network, true);`

This code is inefficient and needs to be refactored. To find the inefficiency look at Etherscan API documentation. You can register to Etherscan for a free API key to test it yourself.

Your task is to refactor this worker and explain how your changes make this worker more efficient. You can write the explanation as comments in the code or as a new `.md` file.