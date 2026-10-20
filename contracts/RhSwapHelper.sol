// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * RhSwapHelper — pemanggil pool Uniswap V3 langsung (2026-10-18).
 *
 * KENAPA ADA: pool V3 selalu memanggil balik `uniswapV3SwapCallback` ke PEMANGGIL. Wallet kita EOA
 * (tanpa kode) → tidak bisa memanggil pool langsung. Kontrak ini yang menerima callback, membayar
 * token input ke pool, lalu mengirim token output ke pemilik (wallet bot).
 *
 * BATAS: hanya pemilik yang bisa memanggil; hanya pool yang sedang dipanggil boleh meminta bayaran;
 * output minimum diperiksa sebelum dikirim (gagal keras bila kurang).
 */
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IUniswapV3Pool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

contract RhSwapHelper {
    address public immutable owner;
    error NotOwner();
    error NotPool();
    error TooMuchAsked();

    constructor() { owner = msg.sender; }

    /// @notice Jual `amountIn` tokenIn → tokenOut lewat pool tertentu.
    /// @dev Pemilik harus sudah memberi izin (approve) tokenIn ke kontrak ini.
    function swapExactIn(
        address pool,
        bool zeroForOne,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96,
        uint256 minOut
    ) external returns (uint256 got) {
        if (msg.sender != owner) revert NotOwner();
        IUniswapV3Pool(pool).swap(address(this), zeroForOne, -int256(amountIn), sqrtPriceLimitX96, abi.encode(pool)); // NEGATIF = exact input
        address out = zeroForOne ? IUniswapV3Pool(pool).token1() : IUniswapV3Pool(pool).token0();
        got = IERC20(out).balanceOf(address(this));
        if (got < minOut) revert TooMuchAsked();
        IERC20(out).transfer(owner, got);
    }

    /// @notice Callback yang diwajibkan pool V3: bayar token input yang kita utang ke msg.sender (pool).
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address pool = abi.decode(data, (address));
        if (msg.sender != pool) revert NotPool();
        int256 owed = amount0Delta > 0 ? amount0Delta : amount1Delta;
        address inTok = amount0Delta > 0 ? IUniswapV3Pool(pool).token0() : IUniswapV3Pool(pool).token1();
        IERC20(inTok).transferFrom(owner, pool, uint256(owed));
    }
}
