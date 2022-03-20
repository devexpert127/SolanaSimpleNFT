import * as anchor from "@project-serum/anchor";
import { Metadata } from "@metaplex/js";

import { MintLayout, TOKEN_PROGRAM_ID, Token } from "@solana/spl-token";
import { sendTransactions, sleep } from ".";
import { fetchHashTable } from "../hooks/useHashTable";
import { SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";

export const CANDY_MACHINE_PROGRAM = new anchor.web3.PublicKey(
    "cndy3Z4yapfJBmL3ShUp5exZKqR3z33thTzeNMm2gRZ"
);

const SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID = new anchor.web3.PublicKey(
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

const TOKEN_METADATA_PROGRAM_ID = new anchor.web3.PublicKey(
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

export const CIVIC = new anchor.web3.PublicKey(
    'gatem74V238djXdzWnJf94Wo1DcnuGkfijbf3AuBhfs',
);

export interface CandyMachine {
    id: anchor.web3.PublicKey;
    connection: anchor.web3.Connection;
    program: anchor.Program;
}

export interface CandyMachineState {
    candyMachine: CandyMachine;
    itemsAvailable: number;
    itemsRedeemed: number;
    itemsRemaining: number;
    treasury: anchor.web3.PublicKey;
  tokenMint: anchor.web3.PublicKey;
  isSoldOut: boolean;
  isActive: boolean;
  isPresale: boolean;
  isWhitelistOnly: boolean;
  goLiveDate: Date;
  price: anchor.BN;
  gatekeeper: null | {
    expireOnUse: boolean;
    gatekeeperNetwork: anchor.web3.PublicKey;
  };
  endSettings: null | {
    number: anchor.BN;
    endSettingType: any;
  };
  whitelistMintSettings: null | {
    mode: any;
    mint: anchor.web3.PublicKey;
    presale: boolean;
    discountPrice: null | anchor.BN;
  };
  hiddenSettings: null | {
    name: string;
    uri: string;
    hash: Uint8Array;
  };
}

export interface CollectionData {
    mint: anchor.web3.PublicKey;
    candyMachine: anchor.web3.PublicKey;
}

export const awaitTransactionSignatureConfirmation = async (
    txid: anchor.web3.TransactionSignature,
    timeout: number,
    connection: anchor.web3.Connection,
    commitment: anchor.web3.Commitment = "recent",
    queryStatus = false
): Promise<anchor.web3.SignatureStatus | null | void> => {
    let done = false;
    let status: anchor.web3.SignatureStatus | null | void = {
        slot: 0,
        confirmations: 0,
        err: null,
    };
    let subId = 0;
    status = await new Promise(async (resolve, reject) => {
        setTimeout(() => {
            if (done) {
                return;
            }
            done = true;
            console.log("Rejecting for timeout...");
            reject({ timeout: true });
        }, timeout);
        try {
            subId = connection.onSignature(
                txid,
                (result: any, context: any) => {
                    done = true;
                    status = {
                        err: result.err,
                        slot: context.slot,
                        confirmations: 0,
                    };
                    if (result.err) {
                        console.log("Rejected via websocket", result.err);
                        reject(status);
                    } else {
                        console.log("Resolved via websocket", result);
                        resolve(status);
                    }
                },
                commitment
            );
        } catch (e) {
            done = true;
            console.error("WS error in setup", txid, e);
        }
        while (!done && queryStatus) {
            (async () => {
                try {
                    const signatureStatuses =
                        await connection.getSignatureStatuses([txid]);
                    status = signatureStatuses && signatureStatuses.value[0];
                    if (!done) {
                        if (!status) {
                            console.log("REST null result for", txid, status);
                        } else if (status.err) {
                            console.log("REST error for", txid, status);
                            done = true;
                            reject(status.err);
                        } else if (!status.confirmations) {
                            console.log(
                                "REST no confirmations for",
                                txid,
                                status
                            );
                        } else {
                            console.log("REST confirmation for", txid, status);
                            done = true;
                            resolve(status);
                        }
                    }
                } catch (e) {
                    if (!done) {
                        console.log("REST connection error: txid", txid, e);
                    }
                }
            })();
            await sleep(2000);
        }
    });

    //@ts-ignore
    if (connection._signatureSubscriptions[subId]) {
        connection.removeSignatureListener(subId);
    }
    done = true;
    console.log("Returning status", status);
    return status;
};

const createAssociatedTokenAccountInstruction = (
    associatedTokenAddress: anchor.web3.PublicKey,
    payer: anchor.web3.PublicKey,
    walletAddress: anchor.web3.PublicKey,
    splTokenMintAddress: anchor.web3.PublicKey
) => {
    const keys = [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: associatedTokenAddress, isSigner: false, isWritable: true },
        { pubkey: walletAddress, isSigner: false, isWritable: false },
        { pubkey: splTokenMintAddress, isSigner: false, isWritable: false },
        {
            pubkey: anchor.web3.SystemProgram.programId,
            isSigner: false,
            isWritable: false,
        },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        {
            pubkey: anchor.web3.SYSVAR_RENT_PUBKEY,
            isSigner: false,
            isWritable: false,
        },
    ];
    return new anchor.web3.TransactionInstruction({
        keys,
        programId: SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
        data: Buffer.from([]),
    });
};

export const getCandyMachineState = async (
    anchorWallet: anchor.Wallet,
    candyMachineId: anchor.web3.PublicKey,
    connection: anchor.web3.Connection
): Promise<CandyMachineState> => {
    const provider = new anchor.Provider(connection, anchorWallet, {
        preflightCommitment: "processed",
    });

    const idl = await anchor.Program.fetchIdl(CANDY_MACHINE_PROGRAM, provider);

    if (idl) {
        const program = new anchor.Program(
            idl,
            CANDY_MACHINE_PROGRAM,
            provider
        );
        const candyMachine = {
            id: candyMachineId,
            connection,
            program,
        };

        const state: any = await program.account.candyMachine.fetch(
            candyMachineId
        );

        const itemsAvailable = state.data.itemsAvailable.toNumber();
        const itemsRedeemed = state.itemsRedeemed.toNumber();
        const itemsRemaining = itemsAvailable - itemsRedeemed;

        let goLiveDate = state.data.goLiveDate.toNumber();
        goLiveDate = new Date(goLiveDate * 1000);

        return {
            candyMachine,
            itemsAvailable,
            itemsRedeemed,
            itemsRemaining,
            goLiveDate,
            isSoldOut: itemsRemaining === 0,
            isActive: false,
            isPresale: false,
            isWhitelistOnly: false,
            treasury: state.wallet,
            tokenMint: state.tokenMint,
            gatekeeper: state.data.gatekeeper,
            endSettings: state.data.endSettings,
            whitelistMintSettings: state.data.whitelistMintSettings,
            hiddenSettings: state.data.hiddenSettings,
            price: state.data.price,
        };
    } else {
        throw new Error(
            `Fetching idl returned null: check CANDY_MACHINE_PROGRAM`
        );
    }
};

const getMasterEdition = async (
    mint: anchor.web3.PublicKey
): Promise<anchor.web3.PublicKey> => {
    return (
        await anchor.web3.PublicKey.findProgramAddress(
            [
                Buffer.from("metadata"),
                TOKEN_METADATA_PROGRAM_ID.toBuffer(),
                mint.toBuffer(),
                Buffer.from("edition"),
            ],
            TOKEN_METADATA_PROGRAM_ID
        )
    )[0];
};

const getMetadata = async (
    mint: anchor.web3.PublicKey
): Promise<anchor.web3.PublicKey> => {
    return (
        await anchor.web3.PublicKey.findProgramAddress(
            [
                Buffer.from("metadata"),
                TOKEN_METADATA_PROGRAM_ID.toBuffer(),
                mint.toBuffer(),
            ],
            TOKEN_METADATA_PROGRAM_ID
        )
    )[0];
};

const getTokenWallet = async (
    wallet: anchor.web3.PublicKey,
    mint: anchor.web3.PublicKey
) => {
    return (
        await anchor.web3.PublicKey.findProgramAddress(
            [wallet.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
            SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID
        )
    )[0];
};

export const getNetworkToken = async (
    wallet: anchor.web3.PublicKey,
    gatekeeperNetwork: anchor.web3.PublicKey,
  ): Promise<[anchor.web3.PublicKey, number]> => {
    return await anchor.web3.PublicKey.findProgramAddress(
      [
        wallet.toBuffer(),
        Buffer.from('gateway'),
        Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
        gatekeeperNetwork.toBuffer(),
      ],
      CIVIC,
    );
};

export const getNetworkExpire = async (
    gatekeeperNetwork: anchor.web3.PublicKey,
    ): Promise<[anchor.web3.PublicKey, number]> => {
    return await anchor.web3.PublicKey.findProgramAddress(
        [gatekeeperNetwork.toBuffer(), Buffer.from('expire')],
        CIVIC,
    );
};

export const getCollectionPDA = async (
    candyMachineAddress: anchor.web3.PublicKey,
  ): Promise<[anchor.web3.PublicKey, number]> => {
    return await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from('collection'), candyMachineAddress.toBuffer()],
      CANDY_MACHINE_PROGRAM,
    );
};

export const getCollectionAuthorityRecordPDA = async (
    mint: anchor.web3.PublicKey,
    newAuthority: anchor.web3.PublicKey,
  ): Promise<anchor.web3.PublicKey> => {
    return (
      await anchor.web3.PublicKey.findProgramAddress(
        [
          Buffer.from('metadata'),
          TOKEN_METADATA_PROGRAM_ID.toBuffer(),
          mint.toBuffer(),
          Buffer.from('collection_authority'),
          newAuthority.toBuffer(),
        ],
        TOKEN_METADATA_PROGRAM_ID,
      )
    )[0];
};

export const getCandyMachineCreator = async (
    candyMachine: anchor.web3.PublicKey,
  ): Promise<[anchor.web3.PublicKey, number]> => {
    return await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from('candy_machine'), candyMachine.toBuffer()],
      CANDY_MACHINE_PROGRAM,
    );
};

export async function getNFTsForOwner(
    connection: anchor.web3.Connection,
    ownerAddress: anchor.web3.PublicKey
) {
    // const allMintsCandyMachine = await fetchHashTable(
    //     process.env.NEXT_PUBLIC_CANDY_MACHINE_ID!
    // );
    const allTokens = [];
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        ownerAddress,
        {
            programId: TOKEN_PROGRAM_ID,
        }
    );

    for (let index = 0; index < tokenAccounts.value.length; index++) {
        const tokenAccount = tokenAccounts.value[index];
        const tokenAmount = tokenAccount.account.data.parsed.info.tokenAmount;

        if (
            tokenAmount.amount == "1" &&
            tokenAmount.decimals == "0" // &&
            // allMintsCandyMachine.includes(
            //     tokenAccount.account.data.parsed.info.mint
            // )
        ) {
            let [pda] = await anchor.web3.PublicKey.findProgramAddress(
                [
                    Buffer.from("metadata"),
                    TOKEN_METADATA_PROGRAM_ID.toBuffer(),
                    new anchor.web3.PublicKey(
                        tokenAccount.account.data.parsed.info.mint
                    ).toBuffer(),
                ],
                TOKEN_METADATA_PROGRAM_ID
            );
            const accountInfo: any = await connection.getParsedAccountInfo(pda);

            const metadata: any = new Metadata(
                ownerAddress.toString(),
                accountInfo.value
            );

            if (metadata.data.updateAuthority == process.env.NEXT_PUBLIC_TREASURY_ADDRESS) {
                const dataRes = await fetch(metadata.data.data.uri);
                console.log(dataRes);
                if (dataRes.status === 202) {
                    allTokens.push(await dataRes.json());
                }
            }
        }
    }

    return allTokens;
}


export const mintOneToken = async (
    candyMachine: CandyMachine,
    payer: anchor.web3.PublicKey,
    state: CandyMachineState
  ): Promise<(string | undefined)[]> => {
    const mint = anchor.web3.Keypair.generate();
  
    const userTokenAccountAddress = await getTokenWallet(payer, mint.publicKey);
  
    const userPayingAccountAddress = state.tokenMint
      ? (await getTokenWallet(payer, state.tokenMint))
      : payer;
  
    const candyMachineAddress = candyMachine.id;
    const remainingAccounts = [];
    const signers: anchor.web3.Keypair[] = [mint];
    const cleanupInstructions = [];
    const instructions = [
      anchor.web3.SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: mint.publicKey,
        space: MintLayout.span,
        lamports:
          await candyMachine.program.provider.connection.getMinimumBalanceForRentExemption(
            MintLayout.span,
          ),
        programId: TOKEN_PROGRAM_ID,
      }),
      Token.createInitMintInstruction(
        TOKEN_PROGRAM_ID,
        mint.publicKey,
        0,
        payer,
        payer,
      ),
      createAssociatedTokenAccountInstruction(
        userTokenAccountAddress,
        payer,
        payer,
        mint.publicKey,
      ),
      Token.createMintToInstruction(
        TOKEN_PROGRAM_ID,
        mint.publicKey,
        userTokenAccountAddress,
        payer,
        [],
        1,
      ),
    ];
  
    if (state.gatekeeper) {
      remainingAccounts.push({
        pubkey: (
          await getNetworkToken(
            payer,
            state.gatekeeper.gatekeeperNetwork,
          )
        )[0],
        isWritable: true,
        isSigner: false,
      });
      if (state.gatekeeper.expireOnUse) {
        remainingAccounts.push({
          pubkey: CIVIC,
          isWritable: false,
          isSigner: false,
        });
        remainingAccounts.push({
          pubkey: (
            await getNetworkExpire(
              state.gatekeeper.gatekeeperNetwork,
            )
          )[0],
          isWritable: false,
          isSigner: false,
        });
      }
    }
    if (state.whitelistMintSettings) {
      const mint = new anchor.web3.PublicKey(
        state.whitelistMintSettings.mint,
      );
  
      const whitelistToken = await getTokenWallet(payer, mint);
      remainingAccounts.push({
        pubkey: whitelistToken,
        isWritable: true,
        isSigner: false,
      });
  
      if (state.whitelistMintSettings.mode.burnEveryTime) {
        const whitelistBurnAuthority = anchor.web3.Keypair.generate();
  
        remainingAccounts.push({
          pubkey: mint,
          isWritable: true,
          isSigner: false,
        });
        remainingAccounts.push({
          pubkey: whitelistBurnAuthority.publicKey,
          isWritable: false,
          isSigner: true,
        });
        signers.push(whitelistBurnAuthority);
        const exists =
          await candyMachine.program.provider.connection.getAccountInfo(
            whitelistToken,
          );
        if (exists) {
          instructions.push(
            Token.createApproveInstruction(
              TOKEN_PROGRAM_ID,
              whitelistToken,
              whitelistBurnAuthority.publicKey,
              payer,
              [],
              1,
            ),
          );
          cleanupInstructions.push(
            Token.createRevokeInstruction(
              TOKEN_PROGRAM_ID,
              whitelistToken,
              payer,
              [],
            ),
          );
        }
      }
    }
  
    if (state.tokenMint) {
      const transferAuthority = anchor.web3.Keypair.generate();
  
      signers.push(transferAuthority);
      remainingAccounts.push({
        pubkey: userPayingAccountAddress,
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: transferAuthority.publicKey,
        isWritable: false,
        isSigner: true,
      });
  
      instructions.push(
        Token.createApproveInstruction(
          TOKEN_PROGRAM_ID,
          userPayingAccountAddress,
          transferAuthority.publicKey,
          payer,
          [],
          state.price.toNumber(),
        ),
      );
      cleanupInstructions.push(
        Token.createRevokeInstruction(
          TOKEN_PROGRAM_ID,
          userPayingAccountAddress,
          payer,
          [],
        ),
      );
    }
    const metadataAddress = await getMetadata(mint.publicKey);
    const masterEdition = await getMasterEdition(mint.publicKey);
  
    const [collectionPDA] = await getCollectionPDA(candyMachineAddress);
    const collectionPDAAccount =
      await candyMachine.program.provider.connection.getAccountInfo(
        collectionPDA,
      );
    if (collectionPDAAccount) {
      try {
        const collectionData =
          (await candyMachine.program.account.collectionPda.fetch(
            collectionPDA,
          )) as CollectionData;
        console.log(collectionData);
        const collectionMint = collectionData.mint;
        const collectionAuthorityRecord = await getCollectionAuthorityRecordPDA(
          collectionMint,
          collectionPDA,
        );
        console.log(collectionMint);
        if (collectionMint) {
          const collectionMetadata = await getMetadata(collectionMint);
          const collectionMasterEdition = await getMasterEdition(collectionMint);
          remainingAccounts.push(
            ...[
              {
                pubkey: collectionPDA,
                isWritable: true,
                isSigner: false,
              },
              {
                pubkey: collectionMint,
                isWritable: false,
                isSigner: false,
              },
              {
                pubkey: collectionMetadata,
                isWritable: true,
                isSigner: false,
              },
              {
                pubkey: collectionMasterEdition,
                isWritable: false,
                isSigner: false,
              },
              {
                pubkey: collectionAuthorityRecord,
                isWritable: false,
                isSigner: false,
              },
            ],
          );
        }
      } catch (error) {
        console.error(error);
      }
    }
  
    const [candyMachineCreator, creatorBump] = await getCandyMachineCreator(
      candyMachineAddress,
    );
  
    instructions.push(
      await candyMachine.program.instruction.mintNft(creatorBump, {
        accounts: {
          candyMachine: candyMachineAddress,
          candyMachineCreator,
          payer: payer,
          wallet: state.treasury,
          mint: mint.publicKey,
          metadata: metadataAddress,
          masterEdition,
          mintAuthority: payer,
          updateAuthority: payer,
          tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
          recentBlockhashes: SYSVAR_SLOT_HASHES_PUBKEY,
          instructionSysvarAccount: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        },
        remainingAccounts:
          remainingAccounts.length > 0 ? remainingAccounts : undefined,
      }),
    );
  
    try {
        const result = (await sendTransactions(
          candyMachine.program.provider.connection,
          candyMachine.program.provider.wallet,
          [instructions, cleanupInstructions],
          [signers, []],
        )
      );
      
      if (typeof result === "number") {
          return [];
      } else {
        return result;
      }
    } catch (e) {
      console.log(e);
    }
  
    return [];
  };
  
// export const mintOneToken = async (
//     candyMachine: CandyMachine,
//     config: anchor.web3.PublicKey, // feels like this should be part of candyMachine?
//     payer: anchor.web3.PublicKey,
//     treasury: anchor.web3.PublicKey
// ): Promise<string> => {
//     const mint = anchor.web3.Keypair.generate();
//     const token = await getTokenWallet(payer, mint.publicKey);
//     const { connection, program } = candyMachine;
//     const metadata = await getMetadata(mint.publicKey);
//     const masterEdition = await getMasterEdition(mint.publicKey);

//     const rent = await connection.getMinimumBalanceForRentExemption(
//         MintLayout.span
//     );
//     return await program.rpc.mintNft({
//         accounts: {
//             config,
//             candyMachine: candyMachine.id,
//             payer: payer,
//             wallet: treasury,
//             mint: mint.publicKey,
//             metadata,
//             masterEdition,
//             mintAuthority: payer,
//             updateAuthority: payer,
//             tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
//             tokenProgram: TOKEN_PROGRAM_ID,
//             systemProgram: anchor.web3.SystemProgram.programId,
//             rent: anchor.web3.SYSVAR_RENT_PUBKEY,
//             clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
//         },
//         signers: [mint],
//         instructions: [
//             anchor.web3.SystemProgram.createAccount({
//                 fromPubkey: payer,
//                 newAccountPubkey: mint.publicKey,
//                 space: MintLayout.span,
//                 lamports: rent,
//                 programId: TOKEN_PROGRAM_ID,
//             }),
//             Token.createInitMintInstruction(
//                 TOKEN_PROGRAM_ID,
//                 mint.publicKey,
//                 0,
//                 payer,
//                 payer
//             ),
//             createAssociatedTokenAccountInstruction(
//                 token,
//                 payer,
//                 payer,
//                 mint.publicKey
//             ),
//             Token.createMintToInstruction(
//                 TOKEN_PROGRAM_ID,
//                 mint.publicKey,
//                 token,
//                 payer,
//                 [],
//                 1
//             ),
//         ],
//     });
// };

export const mintMultipleToken = async (
    candyMachine: any,
    config: anchor.web3.PublicKey,
    payer: anchor.web3.PublicKey,
    treasury: anchor.web3.PublicKey,
    quantity: number = 2
) => {
    const signersMatrix = [];
    const instructionsMatrix = [];

    for (let index = 0; index < quantity; index++) {
        const mint = anchor.web3.Keypair.generate();
        const token = await getTokenWallet(payer, mint.publicKey);
        const { connection } = candyMachine;
        const rent = await connection.getMinimumBalanceForRentExemption(
            MintLayout.span
        );
        const instructions = [
            anchor.web3.SystemProgram.createAccount({
                fromPubkey: payer,
                newAccountPubkey: mint.publicKey,
                space: MintLayout.span,
                lamports: rent,
                programId: TOKEN_PROGRAM_ID,
            }),
            Token.createInitMintInstruction(
                TOKEN_PROGRAM_ID,
                mint.publicKey,
                0,
                payer,
                payer
            ),
            createAssociatedTokenAccountInstruction(
                token,
                payer,
                payer,
                mint.publicKey
            ),
            Token.createMintToInstruction(
                TOKEN_PROGRAM_ID,
                mint.publicKey,
                token,
                payer,
                [],
                1
            ),
        ];
        const masterEdition = await getMasterEdition(mint.publicKey);
        const metadata = await getMetadata(mint.publicKey);

        instructions.push(
            await candyMachine.program.instruction.mintNft({
                accounts: {
                    config,
                    candyMachine: candyMachine.id,
                    payer: payer,
                    wallet: treasury,
                    mint: mint.publicKey,
                    metadata,
                    masterEdition,
                    mintAuthority: payer,
                    updateAuthority: payer,
                    tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    rent: anchor.web3.SYSVAR_RENT_PUBKEY,
                    clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
                },
            })
        );
        const signers: anchor.web3.Keypair[] = [mint];

        signersMatrix.push(signers);
        instructionsMatrix.push(instructions);
    }

    return await sendTransactions(
        candyMachine.program.provider.connection,
        candyMachine.program.provider.wallet,
        instructionsMatrix,
        signersMatrix
    );
};

export const shortenAddress = (address: string, chars = 4): string => {
    return `${address.slice(0, chars)}...${address.slice(-chars)}`;
};
