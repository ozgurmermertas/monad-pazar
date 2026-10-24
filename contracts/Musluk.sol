// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Musluk: demo cüzdanlarına test MON'u dağıtan küçük havuz
/// @notice Monad'ın "reserve balance" kuralı, bakiyesi 10 MON'un altındaki bir EOA'nın
/// art arda değer transferlerini geri çevirebiliyor. Dağıtımı bir sözleşmeden yapınca
/// operatörün işlemi yalnızca gas harcar, değer sözleşmeden çıkar; kural devreye girmez.
contract Musluk {
    address public immutable owner;

    event Dripped(address indexed to, uint256 amount);

    constructor() payable {
        owner = msg.sender;
    }

    receive() external payable {}

    function drip(address payable to, uint256 amount) external {
        require(msg.sender == owner, "sadece operator");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "gonderilemedi");
        emit Dripped(to, amount);
    }

    function withdraw(uint256 amount) external {
        require(msg.sender == owner, "sadece operator");
        (bool ok, ) = payable(owner).call{value: amount}("");
        require(ok, "gonderilemedi");
    }
}
