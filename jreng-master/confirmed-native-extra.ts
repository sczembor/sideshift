import { strict as assert } from 'assert';
import * as ethers from 'ethers';
import pMap from 'p-map';
import { z } from 'zod';
import axios from 'axios';
// `ns` is our own wrapper for bignumber.js to deal with mathematic operations for strings
import { ns } from '@sideshift/shared';
// `Order` is a TypeORM Entity, i.e a database table
// `memGetInternalGqlc` returns a GraphQL client memoized by lodash.memoize function
// `RedisTaskQueue` is a messaging queue that utilizes Redis to store messages
import { Order, createLogger, memGetInternalGqlc, RedisTaskQueue } from '@sideshift/shared-node';
// returns a unique ID to identify deposits
import { getEthereumNativeDepositUniqueId } from './shared';
// `context` stores application data, it uses `p-lazy` for efficiency
import { contextLazy } from './context';

// HACK: Can't find this exported from ethers
type BlocksWithTransactions = Awaited<
  ReturnType<ethers.providers.BaseProvider['getBlockWithTransactions']>
>;

const accountTxListResultSchema = z.array(
  z.object({
    hash: z.string(),
    from: z.string(),
    to: z.string(),
    value: z.string(),
  })
);

const blockHeightResultSchema = z.string();

/**
 * Checks specific deposit addresses for missed deposits
 */
export const runConfirmedNativeTokenExtraWorker = async (): Promise<void> => {
  const context = await contextLazy;
  const {
    config,
    db,
    nativeMethod,
    network,
    nodeProvider,
    config: { etherscanApiKey, evmAccount: account },
  } = context;

  const { asset, id: depositMethodId } = nativeMethod;

  const logger = createLogger('ethereum:deposit:confirmed-native');
  const graphQLClient = memGetInternalGqlc();

  async function fetchOrderForAddress(address: string): Promise<Order | undefined> {
    const order = await db
      .getRepository(Order)
      .createQueryBuilder('o')
      .select()
      .where(`deposit_method = :depositMethodId`, { depositMethodId })
      .andWhere(`deposit_address->>'address' = :address`, { address })
      .getOne();

    return order ?? undefined;
  }

  const scanTxid = async (tx: BlocksWithTransactions['transactions'][0]) => {
    assert.equal(typeof tx, 'object', 'tx is not object');
    assert(tx.from, 'from missing');

    const { hash: txid, blockHash } = tx;

    if (typeof txid !== 'string') {
      throw new Error(`txid must be string`);
    }

    if (typeof blockHash !== 'string') {
      throw new Error(`blockHash must be string`);
    }

    if (!tx.to) {
      // Contract creation
      return false;
    }

    if (tx.to.toLowerCase() !== account.toLowerCase()) {
      // Not the result of a sweep
      return false;
    }

    if (!+tx.value) {
      return false;
    }

    if (tx.gasPrice === undefined) {
      throw new Error('Unsupported EIP-1559 sweep transaction');
    }

    const total = ns.sum(
      tx.value.toString(),
      ns.times(tx.gasLimit.toString(), tx.gasPrice.toString())
    );

    const order = await fetchOrderForAddress(tx.from);

    if (!order) {
      return false;
    }

    const valueAsEther = ethers.utils.formatEther(tx.value);
    const totalAsEther = ethers.utils.formatEther(total);

    const wasCredited = await graphQLClient.maybeInternalCreateDeposit({
      orderId: order.id,
      tx: {
        txid,
      },
      amount: totalAsEther,
      uniqueId: getEthereumNativeDepositUniqueId(nativeMethod, tx.hash),
    });

    if (!wasCredited) {
      return false;
    }

    logger.info(`Stored deposit. ${tx.hash}. ${valueAsEther} ${asset} for order ${order.id}`);

    return true;
  };

  const getEtherScanBlockHeightForTimestamp = async (timestamp: number) => {
    const response = await axios.get(`https://api.etherscan.io/api`, {
      params: {
        module: 'block',
        action: 'getblocknobytime',
        timestamp: timestamp,
        closest: 'before',
        apikey: etherscanApiKey,
      },
    });

    const blockHeightData = blockHeightResultSchema.parse(response.data.result);
    const blockHeight = parseInt(blockHeightData, 10);

    if (!isNaN(blockHeight)) {
      return blockHeight;
    } else {
      console.error('Invalid block height data received:', blockHeightData);
    }
  }

  const getEtherScanTxListForAddress = async (address: string, startBlock: number, page: number, pageSize: number) => {
    const txList = await axios.get(`https://api.etherscan.io/api`, {
      params: {
        module: 'account',
        action: 'txlist',
        address: address,
        startblock: startBlock, // Use the fetched block height as the start block
        endblock: 'latest',
        sort: 'asc', // From oldest to newest
        page: page,
        offset: pageSize,
        apikey: etherscanApiKey,
      },
    }).then(res => accountTxListResultSchema.parse(res));

    return txList;
  };

  const runScanByOrderId = async () => {
    const queue = await RedisTaskQueue.queues.evmNativeConfirm(network, true);

    if (!etherscanApiKey) {
      logger.error('Etherscan not configured');

      return;
    }

    await queue.run(async orderId => {
      logger.info('Processing queued task to look at order %s for deposits', orderId);

      const order = await db.getRepository(Order).findOneBy({ id: orderId });

      if (!order) {
        logger.error('Order %s not found', orderId);

        return;
      }

      if (!order.depositAddress) {
        // The deposit address may have been unassigned
        logger.error('Order %s has no deposit address', orderId);

        return;
      }

      const orderTimestampInSeconds = Math.floor(order.createdAt.getTime() / 1000);
      let startBlock;

      try {
        startBlock = await getEtherScanBlockHeightForTimestamp(orderTimestampInSeconds);
      } catch (error: any) {
        logger.error(error, 'Error fetching blockHeight for order %s: %s', orderId, error.message);

        return;
      }

      let page = 1;
      const pageSize = 100;

      while (true) {

        let txs;

        try {
          txs = await getEtherScanTxListForAddress(order.depositAddress.address, startBlock, page, pageSize);
        } catch (error: any) {
          logger.error(error, 'Error fetching txs for order %s: %s', orderId, error.message);
          return;
        }

        // Only transactions with a value
        txs = txs.filter(tx => ethers.BigNumber.from(tx.value).gt(0));

        logger.info('Found %s transactions for order %s', txs.length, orderId);

        const results = await pMap(txs, async etherscanTx => {
          const ethersTx = await nodeProvider.getTransaction(etherscanTx.hash);

          if (!ethersTx) {
            logger.error('Transaction %s not found', etherscanTx.hash);

            return;
          }

          if (!ethersTx.blockNumber) {
            logger.warn('Transaction %s has no block number', etherscanTx.hash);

            return;
          }

          const block = await nodeProvider.getBlock(ethersTx.blockNumber);

          const timestamp = new Date(block.timestamp * 1000);

          // Only transactions that happened after the order was created
          // This should handle deposit address re-assignment
          if (timestamp.getTime() < order.createdAt.getTime()) {
            logger.warn(
              'Ignoring tx %s that happened before order %s was created',
              etherscanTx.hash,
              orderId
            );

            return;
          }

          logger.info('Scanning tx %s', etherscanTx.hash);

          return await scanTxid(ethersTx);
        });
        if (results.includes(true)) {
          break;
        }
        // if didnt find the transaction continue looking on another page
        page += 1;
      }
    });
  };

  await runScanByOrderId();
};
