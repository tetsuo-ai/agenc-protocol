use crate::state::HASH_SIZE;
use anchor_lang::prelude::*;

/// Wire payload for the explicitly enabled `private-zk` completion path.
/// The production-default program does not compile this instruction surface.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PrivateCompletionPayload {
    pub seal_bytes: Vec<u8>,
    pub journal: Vec<u8>,
    pub image_id: [u8; HASH_SIZE],
    pub binding_seed: [u8; HASH_SIZE],
    pub nullifier_seed: [u8; HASH_SIZE],
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(AnchorSerialize)]
    struct NestedArgs {
        task_id: u64,
        proof: PrivateCompletionPayload,
    }

    #[test]
    fn flattened_program_args_preserve_nested_dto_wire_bytes() {
        let task_id = 0x0807_0605_0403_0201;
        let proof = PrivateCompletionPayload {
            seal_bytes: vec![1, 2, 3, 4, 5],
            journal: vec![6, 7, 8],
            image_id: [9; HASH_SIZE],
            binding_seed: [10; HASH_SIZE],
            nullifier_seed: [11; HASH_SIZE],
        };
        let nested = NestedArgs {
            task_id,
            proof: proof.clone(),
        };
        let flattened = crate::instruction::CompleteTaskPrivate {
            task_id,
            seal_bytes: proof.seal_bytes,
            journal: proof.journal,
            image_id: proof.image_id,
            binding_seed: proof.binding_seed,
            nullifier_seed: proof.nullifier_seed,
        };

        let mut nested_bytes = Vec::new();
        nested.serialize(&mut nested_bytes).unwrap();
        let mut flattened_bytes = Vec::new();
        flattened.serialize(&mut flattened_bytes).unwrap();

        assert_eq!(flattened_bytes, nested_bytes);
    }
}
