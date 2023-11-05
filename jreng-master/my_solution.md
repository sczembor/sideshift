# Refactoring the Deposit Confirmation Worker

The provided code didn't work efficiently as it only analyzed the latest 10 transactions with values from the provided Ethereum account. This limitation could result in missed deposit transactions, especially when more than 10 transactions occurred since the deposit order was created. To address this inefficiency, the code was refactored as follows:

## Changes Made

1. **Fetching the Starting Block**: The refactored code now fetches the starting block based on the order's timestamp. This ensures that no relevant transactions are missed, even if they occurred before the deposit order was created.

2. **Querying Transactions Systematically**: Transactions are queried in ascending order (oldest to newest) using pagination. This systematic approach allows all transactions to be processed, even if there are more than 10 of them.

3. **Loop for Transaction Search**: A loop has been introduced to continue searching for the target transaction across multiple pages until it is found. This ensures that no deposits are missed, even if they are buried within a large number of transactions.

## Benefits

These changes greatly improve the efficiency and accuracy of the deposit confirmation worker. By systematically querying and processing all relevant transactions, the code now guarantees that no deposits go unconfirmed.

This refactoring is crucial for ensuring the reliability of the deposit confirmation process, especially in cases where multiple transactions occur within a short time frame.

## Note on Potential Improvements

There might be a better solution to fetch the orders from the database. Currently there are two very similar queries for order but because of the limited scope I was provided I am not 100% sure on how to handle it.
