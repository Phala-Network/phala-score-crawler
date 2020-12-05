# phala-score-crawler

## Environment
node v15.0.1

## Configuration
Create a new `.env` file in the root directory and write the environment variable:
* `END_POINT`: Phala network node address, default `'wss://poc3.phala.network/ws'`.
* `GOAL_POWER1`: The first goal power.
* `GOAL_POWER2`: The second goal power.
* `GOAL_POWER3`: The third goal power.
* `TIME_LIMIT`: The lower limit of the accumulated time of the lottery pool.

## Install
```bash
yarn
```

## Run
```bash
yarn run start
```

