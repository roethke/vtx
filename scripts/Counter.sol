// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Counter {
    uint256 public n;
    function increment() external { n++; }
    function set(uint256 v) external { n = v; }
    function boom() external pure { revert("boom"); }
}
