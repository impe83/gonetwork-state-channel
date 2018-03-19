const tx = require('ethereumjs-tx')
const util = require('ethereumjs-util')
const sjcl = require('sjcl-all');
const rlp = require('rlp');
const abi = require("ethereumjs-abi");

//empty 32 byte buffer
EMPTY_32BYTE_BUFFER= Buffer.alloc(32);
EMPTY_20BYTE_BUFFER = Buffer.alloc(20);

//TODO: handle out of bounds values for Proof Messages
class Hashable{
  getMessageHash(){
    throw new Error("unimplemented getMessageHash");
  }
}
function TO_BN(value){
  if(util.BN.isBN(value)){
    return value;
  }else{
    return new util.BN(value,16);
  }
}
//we need to handle buffer serialization and deserialization
function JSON_REVIVER_FUNC(k,v) {
      if (
      v !== null            &&
      typeof v === 'object' &&
      'type' in v           &&
      v.type === 'Buffer'   &&
      'data' in v           &&
      Array.isArray(v.data)) {
        return new util.toBuffer(v.data);
      }
      return v;
}



//Messages that merely require signing extend this Base Class
class SignedMessage{


  constructor(options){
    this.signature = null;
  }
  //pack this object for signing
  getHash(){
    throw Error("unimplemented getHash()");
  }

  sign(privateKey){

    //Geth and thus web3 prepends the string \x19Ethereum Signed Message:\n<length of message>
    //to all data before signing it (https://github.com/ethereum/wiki/wiki/JSON-RPC#eth_sign).
    //If you want to verify such a signature from Solidity from web3/geth, you'll have to prepend
    //the same string in solidity before doing the ecrecovery.
    var buffer = this.getHash();
    console.log("SIGNING buffer:"+ buffer.toString('hex'));
    this.signature = util.ecsign(buffer,privateKey);
  }

  _recoverAddress(){
     var buffer = this.getHash();
     var pk = util.ecrecover(buffer,this.signature.v,util.toBuffer(this.signature.r),util.toBuffer(this.signature.s));
     var address = util.pubToAddress(pk);
     return address;
  }

  get from() {
    if(!this.signature){
      throw new Error("no signature to recover address from");
    }
    return this._recoverAddress();
  }

}

//Messages that encapsulate an on chain proof extend ProofMessage base class
//A proof message maybe submitted onchain during settlement to allocate your funds

class ProofMessage extends SignedMessage{
  constructor(options){
    super(options);
    this.nonce = TO_BN(options.nonce) || new util.BN(0);
    this.transferredAmount = TO_BN(options.transferredAmount) || new util.BN(0);
    this.locksRoot = options.locksRoot || EMPTY_32BYTE_BUFFER;
    this.channelAddress = options.channelAddress || EMPTY_20BYTE_BUFFER;
    this.messageHash = options.messageHash || EMPTY_32BYTE_BUFFER;
    this.signature = options.signature || null;

  }

  getHash(){
    var solidityHash = abi.soliditySHA3(
     [ "uint256", "uint256", "address","bytes32","bytes32" ],
     [this.nonce,
      this.transferredAmount,
      this.channelAddress,
      this.locksRoot,
      this.getMessageHash()]);
    return solidityHash;
  }

  getMessageHash(){
    throw new Error("unimplemented getMessageHash");
  }

  toProof(){
    return new ProofMessage(this.nonce, this.transferredAmount,
      this.locksRoot,this.channelAddress,this.getMessageHash(),this.signature);
  }

}

//A lock is included as part of a LockedTransfer message
class Lock extends Hashable{
  constructor(options){
    super(options);
    this.amount = TO_BN(options.amount) || new util.BN(0);
    this.expiration= TO_BN(options.expiration) || new util.BN(0);
    this.hashLock = options.hashLock || EMPTY_32BYTE_BUFFER;
  }

  getMessageHash(){
    var hash =  abi.soliditySHA3(['uint256','uint256','bytes32'],[
      this.amount, this.expiration, this.hashLock]);
    return hash;
  }

}


class DirectTransfer extends ProofMessage{
  constructor(options){
    super(options);
    this.msgID = TO_BN(options.msgID) || new util.BN(0);
    this.to = options.to || EMPTY_20BYTE_BUFFER;

  }

  getMessageHash(){
     var solidityHash = abi.soliditySHA3(
     ["uint256",  "uint256", "uint256", "address","bytes32","address"],
     [this.msgID,
      this.nonce,
      this.transferredAmount,
      this.channelAddress,
      this.locksRoot,
      this.to]);
    return solidityHash;
  }
}

class LockedTransfer extends DirectTransfer{

  constructor(options){
    super(options);
    if(!options.lock){
      options.lock = new Lock({});
    }else if(options.lock instanceof Lock){
      this.lock = options.lock;
    }else if( options.lock instanceof Object){
      this.lock = new Lock(options.lock);
    }
  }

  getMessageHash(){
      console.log("HASH LockedTransfer");

     var solidityHash = abi.soliditySHA3(
     ["uint256",  "uint256", "uint256", "address","bytes32","address","bytes32" ],
     [this.msgID,
      this.nonce,
      this.transferredAmount,
      this.channelAddress,
      this.locksRoot,
      this.to,
      this.lock.getMessageHash()]);
    return solidityHash;
  }

}

class MediatedTransfer extends LockedTransfer{
  constructor(options){
    super(options);
    this.target = options.target || EMPTY_20BYTE_BUFFER; //EthAddress
  }

  getMessageHash(){
     var solidityHash = abi.soliditySHA3(
     ["uint256",  "uint256", "uint256", "address","bytes32","address","address","bytes32" ],
     [this.msgID,
      this.nonce,
      this.transferredAmount,
      this.channelAddress,
      this.locksRoot,
      this.to,
      this.target,
      this.lock.getMessageHash()]);
    return solidityHash;
  }
}

class RequestSecret extends SignedMessage{
  constructor(options){
    super(options);
    this.msgID = TO_BN(options.msgID) || new util.BN(0);
    this.to = options.to || EMPTY_20BYTE_BUFFER;
    this.hashLock = options.hashLock || EMPTY_32BYTE_BUFFER; //Serializable Lock Object
    this.amount = TO_BN(options.amount) || util.BN(0);
  }

  getHash(){
    //we cannot include the expiration as this value is modified by hops at times
    return abi.soliditySHA3(
     [ "uint256", "address", "bytes32","uint256"],
     [this.msgID,this.to, this.hashLock, this.amount]
     );
  }
}

class RevealSecret extends SignedMessage{
  constructor(options){
    super(options);
    this.secret = options.secret || EMPTY_32BYTE_BUFFER;
    this.to = options.to || EMPTY_20BYTE_BUFFER;
  }

   getHash(){
     var solidityHash = abi.soliditySHA3(
     [ "uint256", "address"],
     [this.secret,
      this.to]);
    return solidityHash;
  }
}

//Once a secret is known, if we want to keep the payment channel alive longer
//then the min(openLocks.expired) block, then convert the lock into a balance proof
//using this message.  Without it, we will have to close channel and withdraw on chain
class SecretToProof extends ProofMessage{
  constructor(options){
    super(options);
    this.msgID = TO_BN(options.msgID) || new util.BN(0);
    this.to = options.to || EMPTY_20BYTE_BUFFER;
    this.secret = options.secret || EMPTY_32BYTE_BUFFER;
  }

  getMessageHash(){
     var solidityHash = abi.soliditySHA3(
     [ "uint256", "uint256", "uint256", "address","bytes32","address","bytes32" ],
     [this.msgID,
      this.nonce,
      this.transferredAmount,
      this.channelAddress,
      this.locksRoot, // locksRoot - sha3(secret)
      this.to,
      this.secret]);
    return solidityHash;
  }

}

//Note: We initially avoid signing acks because it basically
//gives an attacker a valid message signature by the signer (which is not intended)
class Ack{
  constructor(options){
    this.to = options.to || EMPTY_20BYTE_BUFFER;
    this.messageHash = options.messageHash || EMPTY_32BYTE_BUFFER;
  }
}

module.exports= {
  SignedMessage,ProofMessage,DirectTransfer,LockedTransfer,MediatedTransfer,
  RequestSecret,RevealSecret,SecretToProof,Ack,Lock, JSON_REVIVER_FUNC
}